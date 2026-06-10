import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EmailStatus, Mailbox } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_EMAIL_PROCESSING } from '../queues/queue-names';
import { MailProviderFactory } from '../../mail/mail-provider.factory';

@Injectable()
export class MailSyncService {
  private readonly logger = new Logger(MailSyncService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly mailProviderFactory: MailProviderFactory,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
  ) {}

  async syncMailbox(mailbox: Mailbox) {
    const configuredProvider = this.mailProviderFactory.getConfiguredProvider();
    const provider = this.mailProviderFactory.createForMailbox(mailbox.email);
    const messages = await provider.syncInbox(20);

    if (!messages.length) {
      return {
        provider: configuredProvider,
        imported: 0,
        skipped: 0,
        emails: [] as any[],
      };
    }

    const providerMessageIds = messages
      .flatMap((m) => {
        // TODO: rename EmailMessage.graphMessageId -> providerMessageId (and add provider column).
        const prefixed = `${m.provider}:${m.providerMessageId}`;
        // Backward compatibility: old Graph sync stored raw message id.
        return m.provider === 'graph'
          ? [prefixed, m.providerMessageId]
          : [prefixed];
      })
      .filter(Boolean);

    const existing = await this.prismaService.emailMessage.findMany({
      where: { graphMessageId: { in: providerMessageIds } },
      select: { graphMessageId: true },
    });

    const existingSet = new Set(existing.map((e) => e.graphMessageId));
    const newMessages = messages.filter((m) => {
      const prefixed = `${m.provider}:${m.providerMessageId}`;
      if (existingSet.has(prefixed)) return false;
      if (m.provider === 'graph' && existingSet.has(m.providerMessageId))
        return false;
      return true;
    });

    const imported: Array<{
      emailMessageId: string;
      providerMessageId: string;
    }> = [];

    for (const message of newMessages) {
      const storedProviderMessageId = `${message.provider}:${message.providerMessageId}`;
      const receivedAt = message.receivedAt ?? new Date();

      let created: { id: string; graphMessageId: string } | null = null;
      try {
        created = await this.prismaService.emailMessage.create({
          data: {
            mailboxId: mailbox.id,
            graphMessageId: storedProviderMessageId,
            conversationId: message.conversationId || storedProviderMessageId,
            messageIdHeader: message.messageIdHeader ?? null,
            inReplyToHeader: message.inReplyToHeader ?? null,
            referencesHeader: message.referencesHeader ?? null,
            threadKey: message.threadKey ?? message.conversationId ?? null,
            fromEmail: message.fromEmail,
            fromName: message.fromName || '',
            subject: message.subject || '',
            bodyText: message.bodyText ?? null,
            bodyHtml: message.bodyHtml ?? null,
            rawMimeBase64: message.rawMimeBase64 ?? null,
            rawMimeFileName: message.rawMimeFileName ?? null,
            rawMimeMimeType: message.rawMimeMimeType ?? null,
            receivedAt,
            hasAttachments: !!message.hasAttachments,
            status: EmailStatus.RECEIVED,
            attachments: message.attachments?.length
              ? {
                  create: message.attachments.map((a, idx) => ({
                    graphAttachmentId:
                      a.providerAttachmentId ?? `${idx + 1}:${a.fileName}`,
                    fileName: a.fileName,
                    mimeType: a.mimeType ?? 'application/octet-stream',
                    size: a.size ?? 0,
                    contentBase64: a.contentBase64 ?? null,
                  })),
                }
              : undefined,
          },
          select: { id: true, graphMessageId: true },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          // Unique constraint hit (graphMessageId). Treat as already synced.
          this.logger.warn(
            `Duplicate providerMessageId=${storedProviderMessageId} ignored during sync`,
          );
          continue;
        }
        throw err;
      }

      if (!created) {
        continue;
      }

      imported.push({
        emailMessageId: created.id,
        providerMessageId: storedProviderMessageId,
      });

      await this.emailProcessingQueue.add('process-email', {
        emailMessageId: created.id,
        graphMessageId: created.graphMessageId,
      });

      this.logger.log(
        `Enqueued email-processing for providerMessageId=${storedProviderMessageId}`,
      );
    }

    const skipped = messages.length - imported.length;
    return {
      provider: messages[0]?.provider,
      imported: imported.length,
      skipped,
      emails: imported,
    };
  }
}
