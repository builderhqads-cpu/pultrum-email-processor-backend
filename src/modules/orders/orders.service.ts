import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CustomerReplyDraftStatus,
  Department,
  FieldRequirement,
  OrderFieldSource,
  OrderStatus,
} from '@prisma/client';
import { ClientProfileService } from '../client-profiles/client-profile.service';
import {
  getRuleRequirement,
  TRANSPORT_BOOKING_FIELD_RULES,
} from '../required-fields/transport-booking-field-rules';
import { routeTimeBounds } from '../../utils/field-normalize';
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
    private readonly clientProfileService: ClientProfileService,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
    @InjectQueue(QUEUE_XML_DELIVERY)
    private readonly xmlDeliveryQueue: Queue,
    @InjectQueue(QUEUE_AI_REQUEST)
    private readonly aiRequestQueue: Queue,
  ) {}

  private getXmlDebugDirectory() {
    return join(process.cwd(), 'debug', 'xml-dumps');
  }

  private buildXmlDebugFileName(orderId: string) {
    const safeOrderId = orderId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${timestamp}_${safeOrderId}.xml`;
  }

  private buildProfileFieldMeta(
    profileFields: Record<string, string>,
    fieldValues?: Record<string, unknown>,
  ) {
    const fieldMetaByKey: Record<
      string,
      { confidence?: number | null; source?: OrderFieldSource }
    > = {};

    for (const [key, value] of Object.entries(profileFields ?? {})) {
      const cleanedProfileValue = (value ?? '').toString().trim();
      if (!key || !cleanedProfileValue) continue;

      if (fieldValues) {
        const finalValue = (fieldValues[key] ?? '').toString().trim();
        if (!finalValue || finalValue !== cleanedProfileValue) continue;
      }

      fieldMetaByKey[key] = {
        confidence: 0.99,
        source: OrderFieldSource.CUSTOMER_PROFILE,
      };
    }

    return fieldMetaByKey;
  }

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

  /** Generates the XML and persists a local debug copy for manual inspection. */
  async dumpXmlDebug(id: string) {
    try {
      const xml = await this.xmlService.generateOrderXml(id);
      const directory = this.getXmlDebugDirectory();
      const fileName = this.buildXmlDebugFileName(id);
      const filePath = join(directory, fileName);

      await mkdir(directory, { recursive: true });
      await writeFile(filePath, xml, 'utf8');

      this.logger.log(
        `XML debug dump created: orderId=${id} path=${filePath}`,
      );

      return {
        ok: true,
        orderId: id,
        fileName,
        filePath,
        xmlLength: xml.length,
      };
    } catch (err: any) {
      throw new BadRequestException(
        err?.message ?? 'Failed to create XML debug dump',
      );
    }
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
        batchImportId: true,
        batchSequence: true,
        externalReference: true,
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

  /**
   * For a batch order there is ONE consolidated reply, held on the batch's
   * primary order (lowest sequence). Any reply operation on a sibling order is
   * routed to that anchor so the same reply is shown and sent from any order.
   */
  private async resolveBatchReplyOrderId(orderId: string): Promise<string> {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      select: { batchImportId: true },
    });
    if (!order?.batchImportId) return orderId;
    const anchor = await this.prismaService.transportOrder.findFirst({
      where: { batchImportId: order.batchImportId },
      orderBy: { batchSequence: 'asc' },
      select: { id: true },
    });
    return anchor?.id ?? orderId;
  }

  async getReplyDraft(orderId: string) {
    const targetId = await this.resolveBatchReplyOrderId(orderId);
    const existing = await this.prismaService.customerReplyDraft.findUnique({
      where: { orderId: targetId },
    });
    if (existing) return existing;
    if (targetId !== orderId) {
      // Batch sibling: the consolidated reply lives on the anchor. If it isn't
      // there, nothing is missing across the batch — no reply to show.
      throw new NotFoundException(
        `Reply draft not found for batch order=${orderId}`,
      );
    }

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
    const targetId = await this.resolveBatchReplyOrderId(orderId);
    const existing = await this.prismaService.customerReplyDraft.findUnique({
      where: { orderId: targetId },
    });
    if (!existing)
      throw new NotFoundException(
        `Reply draft not found for orderId=${orderId}`,
      );

    return this.prismaService.customerReplyDraft.update({
      where: { orderId: targetId },
      data: {
        toEmail: input.toEmail ?? undefined,
        subject: input.subject ?? undefined,
        body:
          input.body != null ? normalizeEscapedNewlines(input.body) : undefined,
      },
    });
  }

  async sendReply(orderId: string) {
    // Batch sibling -> send the ONE consolidated reply held on the anchor.
    orderId = await this.resolveBatchReplyOrderId(orderId);
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
        emailMessage: {
          select: { id: true, graphMessageId: true, subject: true },
        },
        fields: { select: { key: true, value: true } },
      },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);

    // Snapshot the currently-filled fields so a reprocess can never lose data:
    // it may only add/update values, never clear an already-populated field.
    const existingFields: Record<string, string> = {};
    for (const f of order.fields ?? []) {
      const v = (f.value ?? '').toString().trim();
      if (v) existingFields[f.key] = v;
    }

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

    // Batch order: reprocess ONLY this order from its stored rawOrderText,
    // NON-destructively. We do NOT wipe the order's fields first — if the AI
    // call fails, the existing data must stay intact. The single re-fill at the
    // end is the only write, and it preserves everything already present.
    if (order.batchImportId && order.rawOrderText) {
      await this.refillBatchOrder(order, existingFields);
      // Rebuild the ONE consolidated reply for the batch (also clears any stale
      // per-order drafts on sibling orders).
      await this.aiReplyService
        .generateConsolidatedMissingInfoReply(order.batchImportId)
        .catch(() => undefined);
      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: order.id,
        action: 'BATCH_ORDER_REPROCESSED',
        detailsJson: { externalReference: order.externalReference },
      });
      return { enqueued: false, reprocessedOrder: true };
    }

    // Single order: wipe and re-run the whole email pipeline from scratch.
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

  /** Re-fill a single batch order from its stored rawOrderText (no siblings). */
  private async refillBatchOrder(
    order: {
      id: string;
      emailMessageId: string;
      customerEmail: string;
      department: Department;
      rawOrderText: string | null;
      emailMessage: { subject?: string | null } | null;
    },
    existingFields: Record<string, string>,
  ): Promise<void> {
    const text = order.rawOrderText ?? '';
    const profile = this.clientProfileService.resolve({
      fromEmail: order.customerEmail,
      text,
    });
    const presetFields = profile
      ? this.clientProfileService.derive(profile, text)
      : {};

    // Build the AI hints WITHOUT writing to the DB (so a failed AI call cannot
    // gut the order). Known = what we already have + the profile preset.
    const technical = new Set(
      TRANSPORT_BOOKING_FIELD_RULES.filter(
        (r) => r.generated || r.calculable,
      ).map((r) => r.key),
    );
    const known: Record<string, string> = { ...existingFields, ...presetFields };
    const detectedHints = Object.entries(known)
      .filter(([key, value]) => value && !technical.has(key))
      .map(([key, value]) => ({ key, label: key, value, confidence: 0.85 }));
    const missingHints = TRANSPORT_BOOKING_FIELD_RULES.filter(
      (r) => getRuleRequirement(r) === FieldRequirement.REQUIRED && !known[r.key],
    ).map((r) => ({
      key: r.key,
      label: r.label,
      requirement: FieldRequirement.REQUIRED,
      reason: 'Not detected in order content',
    }));

    // AI fills the gaps. If this throws, NOTHING has been written yet, so the
    // order keeps all of its current data.
    const aiPayload = {
      orderId: order.id,
      customerEmail: order.customerEmail ?? null,
      subject: order.emailMessage?.subject ?? null,
      bodyText: null,
      attachmentsText: null,
      combinedText: text,
      requiredFields: TRANSPORT_BOOKING_FIELD_RULES,
      detectedFields: detectedHints,
      missingFields: missingHints,
      department: order.department ?? null,
      language: null,
      emailMetadata: {
        fromEmail: order.customerEmail ?? null,
        fromName: null,
        receivedAt: null,
      },
      clientProfile: profile
        ? this.clientProfileService.payloadSummary(profile)
        : null,
    };

    const aiResult = await this.aiExtractionService.extract(aiPayload);

    // Non-destructive merge: keep everything we already have; the AI only FILLS
    // EMPTY fields (never overwrites). The client-profile preset is the only
    // authoritative source. Single write -> a reprocess can add but never lose.
    const merged: Record<string, unknown> = { ...existingFields };
    for (const [k, v] of Object.entries(aiResult?.fields ?? {})) {
      if (!merged[k] && v != null && v.toString().trim() !== '') merged[k] = v;
    }
    Object.assign(merged, presetFields);

    await this.transportBookingValidationService.validateOrderFromFieldValues(
      {
        orderId: order.id,
        emailMessageId: order.emailMessageId,
        emailSubject: order.emailMessage?.subject ?? '',
        fieldValues: routeTimeBounds(merged, text),
        source: 'ai',
        fieldMetaByKey: this.buildProfileFieldMeta(presetFields, merged),
      },
      { enqueueJobs: false },
    );

    this.logger.log(`Reprocessed batch order ${order.id} from rawOrderText`);
  }

  async sendXml(id: string) {
    const retryableStatuses = new Set<OrderStatus>([
      OrderStatus.READY_TO_XML,
      OrderStatus.CREATIVE_GEARS_REJECTED,
      OrderStatus.FAILED,
    ]);

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
    if (!retryableStatuses.has(order.status)) {
      throw new NotFoundException(
        `Order must be READY_TO_XML or retryable after XML delivery failure/rejection (current=${order.status})`,
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

  async generateReplyDraft(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: { id: true, batchImportId: true },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);

    // Batch order: there is ONE consolidated reply for the whole batch, never a
    // per-order one. Rebuild that instead so we don't create a stray draft.
    if (order.batchImportId) {
      return this.aiReplyService.generateConsolidatedMissingInfoReply(
        order.batchImportId,
      );
    }
    return this.aiReplyService.generateMissingInfoReply(id);
  }

  async generateAiReply(id: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id },
      select: { id: true, batchImportId: true },
    });
    if (!order) throw new NotFoundException(`Order not found: id=${id}`);

    if (order.batchImportId) {
      const res = await this.aiReplyService.generateConsolidatedMissingInfoReply(
        order.batchImportId,
      );
      return res?.draft ?? null;
    }
    const res = await this.aiReplyService.generateMissingInfoReply(id);
    return res.draft;
  }
}
