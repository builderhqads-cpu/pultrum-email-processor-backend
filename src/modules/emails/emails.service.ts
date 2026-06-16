import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_EMAIL_PROCESSING } from '../queues/queue-names';

@Injectable()
export class EmailsService {
  constructor(
    private readonly prismaService: PrismaService,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
  ) {}

  async findAll() {
    const emails = await this.prismaService.emailMessage.findMany({
      orderBy: { receivedAt: 'desc' },
      select: {
        id: true,
        graphMessageId: true,
        conversationId: true,
        threadKey: true,
        fromEmail: true,
        subject: true,
        receivedAt: true,
        status: true,
        isTransportOrder: true,
        classificationReason: true,
        classifiedAt: true,
        mailbox: {
          select: {
            id: true,
            email: true,
            department: true,
            active: true,
            lastSyncedAt: true,
          },
        },
      },
    });

    return emails.map((e) => ({
      id: e.id,
      providerMessageId: e.graphMessageId,
      conversationId: e.conversationId,
      threadKey: e.threadKey,
      fromEmail: e.fromEmail,
      subject: e.subject,
      receivedAt: e.receivedAt,
      status: e.status,
      isTransportOrder: e.isTransportOrder,
      classificationReason: e.classificationReason,
      classifiedAt: e.classifiedAt,
      mailbox: e.mailbox,
    }));
  }

  private async enqueueProcessing(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      select: { id: true, graphMessageId: true },
    });
    if (!email) throw new NotFoundException(`Email not found: id=${id}`);

    await this.emailProcessingQueue.add('process-email', {
      emailMessageId: email.id,
      graphMessageId: email.graphMessageId,
    });

    return email;
  }

  /** Re-run the full pipeline (re-classifies, then proceeds if transport). */
  async reclassify(id: string) {
    await this.enqueueProcessing(id);
    return { enqueued: true };
  }

  /**
   * Manual override for a false negative: mark the email as a transport order so
   * the classification gate is skipped, then reprocess to create the order.
   */
  async processAnyway(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!email) throw new NotFoundException(`Email not found: id=${id}`);

    await this.prismaService.emailMessage.update({
      where: { id },
      data: { isTransportOrder: true },
    });

    await this.enqueueProcessing(id);
    return { enqueued: true };
  }

  async findOne(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      include: {
        mailbox: true,
        attachments: true,
        order: true,
        linkedOrder: true,
      },
    });

    if (!email) {
      throw new NotFoundException(`Email not found: id=${id}`);
    }

    const order = email.order ?? email.linkedOrder;

    return {
      id: email.id,
      providerMessageId: email.graphMessageId,
      graphMessageId: email.graphMessageId,
      conversationId: email.conversationId,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      receivedAt: email.receivedAt,
      hasAttachments: email.hasAttachments,
      status: email.status,
      isTransportOrder: email.isTransportOrder,
      classificationReason: email.classificationReason,
      classificationLanguage: email.classificationLanguage,
      classifiedAt: email.classifiedAt,
      mailbox: email.mailbox,
      attachments: email.attachments,
      order: order
        ? {
            id: order.id,
            status: order.status,
            department: order.department,
            type: order.type,
            overallConfidence: order.overallConfidence,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          }
        : null,
    };
  }

  async remove(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!email) {
      throw new NotFoundException(`Email not found: id=${id}`);
    }

    const deletedReplyEmailsCount = await this.prismaService.$transaction(
      async (tx) => {
        if (!email.order) {
          await tx.emailMessage.delete({
            where: { id },
          });

          return 0;
        }

        const linkedReplies = await tx.emailMessage.findMany({
          where: { linkedOrderId: email.order.id },
          select: { id: true },
        });

        const linkedReplyIds = linkedReplies.map((reply) => reply.id);

        if (linkedReplyIds.length > 0) {
          await tx.emailMessage.deleteMany({
            where: {
              id: { in: linkedReplyIds },
            },
          });
        }

        await tx.emailMessage.delete({
          where: { id },
        });

        return linkedReplyIds.length;
      },
    );

    return {
      ok: true,
      deletedEmailId: id,
      deletedOrderId: email.order?.id ?? null,
      deletedReplyEmailsCount,
    };
  }
}
