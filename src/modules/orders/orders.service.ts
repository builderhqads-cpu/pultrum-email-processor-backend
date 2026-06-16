import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerReplyDraftStatus, OrderStatus } from '@prisma/client';
import {
  QUEUE_AI_REQUEST,
  QUEUE_EMAIL_PROCESSING,
  QUEUE_XML_DELIVERY,
} from '../queues/queue-names';
import { EmailSenderService } from '../email-sender/email-sender.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AiClientService } from '../ai-client/ai-client.service';
import { normalizeEscapedNewlines } from '../../utils/sanitize';
import { ExtractionPipelineService } from '../extraction-pipeline/extraction-pipeline.service';
import { AiExtractionService } from '../ai-extraction/ai-extraction.service';
import { TransportBookingValidationService } from '../transport-booking-validation/transport-booking-validation.service';
import { AiReplyService } from '../ai-reply/ai-reply.service';
import { XmlService } from '../xml/xml.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly emailSenderService: EmailSenderService,
    private readonly auditLogService: AuditLogService,
    private readonly aiClientService: AiClientService,
    private readonly extractionPipelineService: ExtractionPipelineService,
    private readonly aiExtractionService: AiExtractionService,
    private readonly transportBookingValidationService: TransportBookingValidationService,
    private readonly aiReplyService: AiReplyService,
    private readonly xmlService: XmlService,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
    @InjectQueue(QUEUE_XML_DELIVERY)
    private readonly xmlDeliveryQueue: Queue,
    @InjectQueue(QUEUE_AI_REQUEST)
    private readonly aiRequestQueue: Queue,
  ) {}

  /** Generates the Creative Gears XML on demand (read-only) for preview. */
  async previewXml(id: string) {
    try {
      const xml = await this.xmlService.generateOrderXml(id);
      return { xml };
    } catch (err: any) {
      throw new BadRequestException(
        err?.message ?? 'Failed to generate XML preview',
      );
    }
  }

  private async applyAiMissingFieldReasons(
    orderId: string,
    missingFields: Array<{ key: string; label: string; reason: string }>,
  ) {
    if (!missingFields.length) return;

    await this.prismaService.$transaction(async (tx) => {
      for (const field of missingFields) {
        await tx.missingField.updateMany({
          where: { orderId, key: field.key },
          data: {
            label: field.label,
            reason: field.reason,
          },
        });
      }
    });
  }

  private async buildAiExtractionSummary(order: {
    id: string;
    status: string;
    updatedAt: Date;
    fields: Array<{
      source?: string | null;
      value?: string | null;
      updatedAt?: Date;
      createdAt?: Date;
    }>;
  }) {
    const relevantLogs = await this.prismaService.auditLog.findMany({
      where: {
        entityType: 'TransportOrder',
        entityId: order.id,
        action: {
          in: [
            'AI_AUTO_PROCESSING_TRIGGERED',
            'AI_AUTO_PROCESSING_SKIPPED',
            'AI_EXTRACTION_REQUESTED',
            'AI_EXTRACTION_COMPLETED',
            'AI_EXTRACTION_FAILED',
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const nonEmptyAiFields = (order.fields ?? []).filter(
      (field) =>
        field.source === 'AI' &&
        (field.value ?? '').toString().trim().length > 0,
    );

    const latestOf = (action: string) =>
      [...relevantLogs]
        .reverse()
        .find((log) => log.action === action);

    const latestFailed = latestOf('AI_EXTRACTION_FAILED');
    const latestCompleted = latestOf('AI_EXTRACTION_COMPLETED');
    const latestRequested = latestOf('AI_EXTRACTION_REQUESTED');
    const latestTriggered = latestOf('AI_AUTO_PROCESSING_TRIGGERED');
    const latestSkipped = [...relevantLogs]
      .reverse()
      .find(
        (log) =>
          log.action === 'AI_AUTO_PROCESSING_SKIPPED' &&
          (log.detailsJson as any)?.reason ===
            'Deterministic validation considered sufficient.',
      );

    if (nonEmptyAiFields.length > 0) {
      const latestAiFieldAt = [...nonEmptyAiFields]
        .map((field) => field.updatedAt ?? field.createdAt ?? null)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => b.getTime() - a.getTime())[0];

      return {
        status: 'COMPLETED',
        date:
          latestCompleted?.createdAt?.toISOString() ??
          latestAiFieldAt?.toISOString() ??
          latestTriggered?.createdAt?.toISOString() ??
          order.updatedAt?.toISOString() ??
          null,
        reason: null,
      };
    }

    if (
      latestFailed &&
      (!latestCompleted ||
        latestFailed.createdAt.getTime() >= latestCompleted.createdAt.getTime())
    ) {
      return {
        status: 'FAILED',
        date: latestFailed.createdAt.toISOString(),
        reason:
          ((latestFailed.detailsJson as any)?.message as string | undefined) ??
          null,
      };
    }

    if (latestSkipped) {
      return {
        status: 'SKIPPED',
        date: latestSkipped.createdAt.toISOString(),
        reason:
          ((latestSkipped.detailsJson as any)?.reason as string | undefined) ??
          null,
      };
    }

    if (latestRequested || latestTriggered) {
      const log = latestRequested ?? latestTriggered ?? null;
      return {
        status: 'PENDING',
        date: log?.createdAt?.toISOString() ?? null,
        reason: null,
      };
    }

    return {
      status: 'PENDING',
      date: null,
      reason: null,
    };
  }

  async findAll() {
    const orders = await this.prismaService.transportOrder.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        department: true,
        type: true,
        customerEmail: true,
        overallConfidence: true,
        emailMessageId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            missingFields: true,
          },
        },
      },
    });

    const orderIds = orders.map((order) => order.id);
    const auditLogs = orderIds.length
      ? await this.prismaService.auditLog.findMany({
          where: { entityType: 'TransportOrder', entityId: { in: orderIds } },
          orderBy: { createdAt: 'desc' },
          select: { entityId: true, action: true, createdAt: true },
        })
      : [];

    const lastAuditByOrder = new Map<
      string,
      { action: string; createdAt: Date }
    >();
    for (const log of auditLogs) {
      if (!lastAuditByOrder.has(log.entityId)) {
        lastAuditByOrder.set(log.entityId, {
          action: log.action,
          createdAt: log.createdAt,
        });
      }
    }

    return orders.map(({ _count, ...order }) => {
      const lastAudit = lastAuditByOrder.get(order.id) ?? null;
      return {
        ...order,
        missingFieldsCount: _count.missingFields,
        lastAudit: lastAudit
          ? {
              action: lastAudit.action,
              createdAt: lastAudit.createdAt.toISOString(),
            }
          : null,
      };
    });
  }

  async findOne(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      include: {
        fields: true,
        missingFields: true,
        validationWarnings: true,
        aiRequests: {
          include: { replyDraft: { select: { id: true } } },
        },
        xmlDeliveries: true,
        replyDraft: true,
      },
    });

    if (!order) throw new NotFoundException(`Order not found: id=${id}`);
    const aiExtraction = await this.buildAiExtractionSummary(order);
    // Derive the AI request type (no DB column): a request linked to a customer
    // reply draft is a reply generation; everything else is processing.
    const aiRequests = order.aiRequests.map(({ replyDraft, ...request }) => ({
      ...request,
      type: replyDraft ? 'REPLY' : 'PROCESSING',
    }));
    return {
      ...order,
      aiRequests,
      aiExtraction,
    };
  }

  async getReplyDraft(orderId: string) {
    const existing = await this.prismaService.customerReplyDraft.findUnique({
      where: { orderId },
    });
    if (existing) return existing;

    // Backfill: if an AI request succeeded previously but draft wasn't created (legacy behavior),
    // build a draft from the latest successful AiRequest response.
    const lastAi = await this.prismaService.aiRequest.findFirst({
      where: { orderId, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, responseJson: true },
    });

    if (!lastAi?.responseJson) {
      throw new NotFoundException(
        `Reply draft not found for orderId=${orderId}`,
      );
    }

    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerEmail: true,
        replyToken: true,
        conversationKey: true,
      },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${orderId}`);

    const short = orderId.split('-')[0] || '';
    const replyToken = order.replyToken || (short ? `PULTRUM-${short}` : null);
    if (replyToken && (!order.replyToken || !order.conversationKey)) {
      await this.prismaService.transportOrder.update({
        where: { id: orderId },
        data: {
          replyToken: order.replyToken ?? replyToken,
          conversationKey: order.conversationKey ?? replyToken,
        },
      });
    }

    const output = (this.aiClientService as any).extractSuggestedReply?.(
      lastAi.responseJson,
    ) as string | null | undefined;
    const suggestedSubject = (
      this.aiClientService as any
    ).extractSuggestedSubject?.(lastAi.responseJson) as
      | string
      | null
      | undefined;

    if (!output || !output.trim()) {
      throw new NotFoundException(
        `Reply draft not found for orderId=${orderId} (AI response has no replyBody)`,
      );
    }

    const body = normalizeEscapedNewlines(output.trim());
    const tokenMarker = replyToken ? `[${replyToken}]` : null;
    const bodyWithToken =
      tokenMarker && !body.includes(tokenMarker)
        ? `${body}\n\nReference: ${tokenMarker}`
        : body;

    const fallbackSubject = (this.aiClientService as any).buildDraftSubject?.(
      orderId,
    ) as string | undefined;

    return this.prismaService.customerReplyDraft.create({
      data: {
        orderId,
        aiRequestId: lastAi.id,
        toEmail: order.customerEmail,
        subject:
          (suggestedSubject && suggestedSubject.trim()) ||
          fallbackSubject ||
          `Aanvullende informatie nodig - [PULTRUM-${orderId.split('-')[0]}]`,
        body: bodyWithToken,
        status: CustomerReplyDraftStatus.DRAFT,
      },
    });
  }

  async updateReplyDraft(
    orderId: string,
    input: { toEmail?: string; subject?: string; body?: string },
  ) {
    const existing = await this.prismaService.customerReplyDraft.findUnique({
      where: { orderId },
    });
    if (!existing)
      throw new NotFoundException(
        `Reply draft not found for orderId=${orderId}`,
      );

    return this.prismaService.customerReplyDraft.update({
      where: { orderId },
      data: {
        toEmail: input.toEmail ?? undefined,
        subject: input.subject ?? undefined,
        body:
          input.body != null ? normalizeEscapedNewlines(input.body) : undefined,
      },
    });
  }

  async sendReply(orderId: string) {
    const draft = await this.prismaService.customerReplyDraft.findUnique({
      where: { orderId },
    });
    if (!draft)
      throw new NotFoundException(
        `Reply draft not found for orderId=${orderId}`,
      );
    // Resending is allowed (e.g. reminders) — no status guard.

    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: {
          include: {
            mailbox: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${orderId}`);

    const sendResult = await this.emailSenderService.sendEmail({
      mailboxEmail: order.emailMessage?.mailbox?.email ?? null,
      toEmail: draft.toEmail,
      subject: draft.subject,
      body: normalizeEscapedNewlines(draft.body),
      // Optional Reply-To for inbound replies
      replyTo: null,
      // SMTP threading headers (Graph uses native reply below instead).
      inReplyTo: order.emailMessage?.messageIdHeader ?? null,
      references: order.emailMessage?.messageIdHeader ?? null,
      // Graph: reply natively to the original message so it threads.
      replyToGraphMessageId: order.emailMessage?.graphMessageId ?? null,
      // Per-mailbox signature (production); empty in test.
      signature: order.emailMessage?.mailbox?.signature ?? null,
    });

    await this.prismaService.customerReplyDraft.update({
      where: { orderId },
      data: {
        status: CustomerReplyDraftStatus.SENT,
        sentAt: new Date(),
      },
    });

    // Keep order waiting state (as requested).
    await this.prismaService.transportOrder.update({
      where: { id: orderId },
      data: { status: OrderStatus.WAITING_CUSTOMER_RESPONSE },
    });

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: orderId,
      action: 'ORDER_REPLY_SENT',
      detailsJson: {
        toEmail: draft.toEmail,
        subject: draft.subject,
        provider: sendResult.provider,
        mocked: sendResult.mocked,
        messageId: sendResult.messageId ?? null,
      },
    });

    return {
      ok: true,
      provider: sendResult.provider,
      mocked: sendResult.mocked,
      messageId: sendResult.messageId ?? null,
    };
  }

  async reprocess(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      include: {
        emailMessage: { select: { id: true, graphMessageId: true } },
      },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);

    // Remove any idempotent jobs so the new validation can enqueue again.
    const aiJobId = `ai-request_${order.id}`;
    const xmlJobId = `xml-delivery_${order.id}`;

    await Promise.all([
      this.aiRequestQueue
        .getJob(aiJobId)
        .then((job) => job?.remove())
        .catch(() => undefined),
      this.xmlDeliveryQueue
        .getJob(xmlJobId)
        .then((job) => job?.remove())
        .catch(() => undefined),
    ]);

    const cleanup = await this.prismaService.$transaction(async (tx) => {
      const missingFields = await tx.missingField.deleteMany({
        where: { orderId: order.id },
      });
      const orderFields = await tx.orderField.deleteMany({
        where: { orderId: order.id },
      });
      const aiRequests = await tx.aiRequest.deleteMany({
        where: { orderId: order.id },
      });
      const xmlDeliveries = await tx.xmlDelivery.deleteMany({
        where: { orderId: order.id },
      });

      await tx.transportOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.PROCESSING, overallConfidence: null },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'TransportOrder',
          entityId: order.id,
          action: 'ORDER_REPROCESSED',
          detailsJson: {
            emailMessageId: order.emailMessageId,
            deleted: {
              missingFields: missingFields.count,
              orderFields: orderFields.count,
              aiRequests: aiRequests.count,
              xmlDeliveries: xmlDeliveries.count,
            },
          } as any,
        },
      });

      return {
        missingFields: missingFields.count,
        orderFields: orderFields.count,
        aiRequests: aiRequests.count,
        xmlDeliveries: xmlDeliveries.count,
      };
    });

    await this.emailProcessingQueue.add('process-email', {
      emailMessageId: order.emailMessageId,
      graphMessageId: order.emailMessage.graphMessageId,
    });

    return { enqueued: true, cleanup };
  }

  async sendXml(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        missingFields: {
          select: {
            key: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);
    if (order.missingFields.length > 0) {
      const keys = order.missingFields.map((field) => field.key).join(', ');
      throw new NotFoundException(
        `Order cannot send XML while required fields are missing: ${keys}`,
      );
    }
    if (order.status !== OrderStatus.READY_TO_XML) {
      throw new NotFoundException(
        `Order must be READY_TO_XML before sending XML (current=${order.status})`,
      );
    }

    await this.xmlDeliveryQueue.add(
      'xml-delivery',
      { orderId: id },
      { jobId: `manual_xml-delivery_${id}_${Date.now()}` },
    );

    return { enqueued: true };
  }

  async sendAiRequest(id: string) {
    // Backward-compatible alias for "generate reply draft".
    return this.generateReplyDraft(id);
  }

  async processWithAi(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: { id: true, emailMessageId: true },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);

    this.logger.log(`AI extraction started orderId=${id}`);

    const aiExtractionResult =
      await this.aiExtractionService.extractTransportOrder(id);

    this.logger.log(`AI extraction completed orderId=${id}`);

    const afterAi = await this.prismaService.transportOrder.findUnique({
      where: { id },
      include: {
        emailMessage: { select: { subject: true } },
        fields: true,
        missingFields: true,
        validationWarnings: true,
      },
    });
    if (!afterAi)
      throw new NotFoundException(`Order not found after AI: id=${id}`);

    const fieldValues: Record<string, unknown> = {};
    for (const f of afterAi.fields ?? []) {
      const v = (f.value ?? '').toString().trim();
      if (!v) continue;
      fieldValues[f.key] = v;
    }

    const validation =
      await this.transportBookingValidationService.validateOrderFromFieldValues(
        {
          orderId: afterAi.id,
          emailMessageId: order.emailMessageId,
          emailSubject: afterAi.emailMessage?.subject ?? '',
          fieldValues,
          source: 'ai',
        },
        {
          enqueueJobs: false,
          incompleteStatus: OrderStatus.MISSING_INFORMATION,
        },
      );

    if (aiExtractionResult.missingFields?.length) {
      await this.applyAiMissingFieldReasons(
        id,
        aiExtractionResult.missingFields,
      );
    }

    const detectedFields = (afterAi.fields ?? []).filter(
      (f) => (f.value ?? '').toString().trim().length > 0,
    );

    const updated = await this.prismaService.transportOrder.findUnique({
      where: { id },
      include: {
        emailMessage: true,
        fields: true,
        missingFields: true,
        validationWarnings: true,
        aiRequests: true,
        xmlDeliveries: true,
        replyDraft: true,
      },
    });

    const finalMissingFields =
      updated?.missingFields ?? validation.missingFields;

    this.logger.log(
      `AI process-with-ai result orderId=${id} detected=${detectedFields.length} missing=${finalMissingFields.length}`,
    );

    return {
      order: updated,
      detectedFields,
      missingFields: finalMissingFields,
    };
  }

  async generateReplyDraft(id: string) {
    const exists = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Order not found: id=${id}`);

    const res = await this.aiReplyService.generateMissingInfoReply(id);
    return res;
  }

  async generateAiReply(id: string) {
    const exists = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Order not found: id=${id}`);

    const res = await this.aiReplyService.generateMissingInfoReply(id);
    return res.draft;
  }
}
