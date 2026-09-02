import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
  ) {}

  async syncMailbox(mailbox: Mailbox) {
    const configuredProvider = this.mailProviderFactory.getConfiguredProvider();
    const provider = this.mailProviderFactory.createForMailbox(mailbox.email);

    // Intake-folder mode: the planner curates a folder (e.g. "AI BOB") with ONLY
    // order emails, so we process EVERYTHING in it (dedup prevents repeats) and
    // must NOT apply the date cutoff — a dragged email keeps its original
    // receivedDateTime, which could be older than the cutoff and be wrongly
    // dropped. Without a folder, keep the high-water mark so a plain-Inbox sync
    // never pulls the historical backlog.
    const intakeFolder = (
      this.configService.get<string>('GRAPH_INTAKE_FOLDER') || ''
    ).trim();
    const since = intakeFolder
      ? undefined
      : (mailbox.processMessagesFrom ?? mailbox.createdAt ?? undefined);

    // List message HEADERS only (cheap, no raw MIME). We dedup against the DB
    // BEFORE downloading any .eml, so already-imported messages cost nothing and
    // a curated intake folder is read in full (no top-N blind spot).
    const listed = await provider.listMessages(since);
    // Authoritative guard (belt-and-suspenders): enforce the cutoff even if the
    // provider ignores the `since` hint.
    const messages = since
      ? listed.filter((m) => m.receivedAt.getTime() >= since.getTime())
      : listed;

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

    // Now — and only now — download the raw .eml, for the NEW messages only.
    // Graph headers arrive without it; IMAP already includes it (fetchRawMime is
    // a no-op there). This is the whole point: no .eml download for already-known
    // messages, so the folder can be listed in full cheaply.
    for (const message of newMessages) {
      if (!message.rawMimeBase64) {
        message.rawMimeBase64 =
          (await provider.fetchRawMime(message.providerMessageId)) ?? undefined;
      }
    }

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
