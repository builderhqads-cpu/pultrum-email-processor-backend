import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  AttachmentExtractionStatus,
  BatchImportStatus,
  Department,
  EmailLinkMethod,
  EmailStatus,
  OrderFieldSource,
  OrderStatus,
  OrderType,
  TransportOrder,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { QUEUE_EMAIL_PROCESSING } from '../queues/queue-names';
import { RequiredFieldsService } from '../required-fields/required-fields.service';
import { GraphService } from '../graph/graph.service';
import { AttachmentParserService } from '../attachment-parser/attachment-parser.service';
import { OrderClassifierService } from '../order-classifier/order-classifier.service';
import { ThreadLinkingService } from '../thread-linking/thread-linking.service';
import { EmailContextMapperService } from '../thread-linking/email-context-mapper.service';
import { AiExtractionService } from '../ai-extraction/ai-extraction.service';
import { AiClassificationService } from '../ai-classification/ai-classification.service';
import { TRANSPORT_BOOKING_FIELD_RULES } from '../required-fields/transport-booking-field-rules';
import { TransportBookingValidationService } from '../transport-booking-validation/transport-booking-validation.service';
import { ClientProfileService } from '../client-profiles/client-profile.service';
import { OrderSplitService } from '../order-split/order-split.service';
import { AiReplyService } from '../ai-reply/ai-reply.service';
import { AddressEnrichmentService } from '../geocoding/address-enrichment.service';
import type { SplitResult } from '../order-split/order-split.types';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import { routeTimeBounds } from '../../utils/field-normalize';
import {
  FieldMergeService,
  type MergeableField,
} from '../field-merge/field-merge.service';

@Processor(QUEUE_EMAIL_PROCESSING)
export class EmailProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessingProcessor.name);
  private readonly aiExcludeKeys = new Set(
    TRANSPORT_BOOKING_FIELD_RULES.filter(
      (r) => r.generated || r.calculable,
    ).map((r) => r.key),
  );

  constructor(
    private readonly prismaService: PrismaService,
    private readonly requiredFieldsService: RequiredFieldsService,
    private readonly auditLogService: AuditLogService,
    private readonly graphService: GraphService,
    private readonly attachmentParserService: AttachmentParserService,
    private readonly orderClassifierService: OrderClassifierService,
    private readonly threadLinkingService: ThreadLinkingService,
    private readonly emailContextMapperService: EmailContextMapperService,
    private readonly aiExtractionService: AiExtractionService,
    private readonly transportBookingValidationService: TransportBookingValidationService,
    private readonly fieldMergeService: FieldMergeService,
    private readonly aiClassificationService: AiClassificationService,
    private readonly clientProfileService: ClientProfileService,
    private readonly orderSplitService: OrderSplitService,
    private readonly aiReplyService: AiReplyService,
    private readonly addressEnrichmentService: AddressEnrichmentService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  private mergeMissingFieldValues(
    fieldValues: Record<string, unknown>,
    detectedFields: Array<{
      key: string;
      value: string;
    }>,
  ) {
    const merged = { ...fieldValues };
    for (const field of detectedFields ?? []) {
      const key = (field?.key ?? '').toString().trim();
      if (!key) continue;
      const value = sanitizeExtractedValue(field?.value ?? '');
      if (!value) continue;
      const current = sanitizeExtractedValue(
        merged[key] == null ? '' : String(merged[key]),
      );
      if (current) continue;
      merged[key] = value;
    }
    return merged;
  }

  private mergeDetectedFields(
    base: Array<{
      key: string;
      label: string;
      value: string;
      confidence: number;
    }>,
    additions: Array<{
      key: string;
      label: string;
      value: string;
      confidence: number;
    }>,
  ) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((field) => field.key));
    for (const field of additions ?? []) {
      if (!field?.key || seen.has(field.key)) continue;
      const value = sanitizeExtractedValue(field.value ?? '');
      if (!value) continue;
      merged.push({
        key: field.key,
        label: field.label,
        value,
        confidence: field.confidence,
      });
      seen.add(field.key);
    }
    return merged;
  }

  private profileFieldLabel(key: string) {
    return (
      TRANSPORT_BOOKING_FIELD_RULES.find((rule) => rule.key === key)?.label ??
      key
    );
  }

  private toProfileDetectedFields(profileFields: Record<string, string>) {
    return Object.entries(profileFields ?? {})
      .map(([key, value]) => {
        const cleaned = sanitizeExtractedValue(value ?? '');
        if (!key || !cleaned) return null;
        return {
          key,
          label: this.profileFieldLabel(key),
          value: cleaned,
          confidence: 0.99,
        };
      })
      .filter((field): field is NonNullable<typeof field> => Boolean(field));
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
      const cleanedProfileValue = sanitizeExtractedValue(value ?? '');
      if (!key || !cleanedProfileValue) continue;

      if (fieldValues) {
        const finalValue = sanitizeExtractedValue(
          fieldValues[key] == null ? '' : String(fieldValues[key]),
        );
        if (!finalValue || finalValue !== cleanedProfileValue) continue;
      }

      fieldMetaByKey[key] = {
        confidence: 0.99,
        source: OrderFieldSource.CUSTOMER_PROFILE,
      };
    }

    return fieldMetaByKey;
  }

  private async resolveZipcodeEnrichment(params: {
    combinedText?: string | null;
    emailSubject?: string | null;
    fieldValues?: Record<string, unknown>;
    detectedFields?: Array<{
      key: string;
      label?: string | null;
      value?: string | null;
      confidence?: number | null;
      source?: string | null;
    }>;
  }) {
    return this.addressEnrichmentService.resolveZipcodeHints({
      combinedText: params.combinedText,
      emailSubject: params.emailSubject,
      fieldValues: params.fieldValues,
      detectedFields: params.detectedFields,
    });
  }

  /**
   * Run the SAME fill-in processing a single order gets, for one order's text:
   * deterministic preset fields first, then the configured AI extraction route
   * to fill the gaps, then merge (client-profile preset stays authoritative)
   * and validate. Used by the batch path so each split order is fully processed.
   */
  private async fillOrder(params: {
    orderId: string;
    emailMessageId: string;
    emailSubject: string;
    text: string;
    presetFields: Record<string, string>;
    department: Department | null;
    customerEmail: string | null;
    fromEmail: string | null;
    fromName: string | null;
    receivedAt: Date | null;
    bodyText: string | null;
    language: string | null;
    enqueueJobs: boolean;
  }): Promise<void> {
    // 1) Deterministic: apply the profile-derived preset fields.
    const det =
      await this.transportBookingValidationService.validateOrderFromFieldValues(
        {
          orderId: params.orderId,
          emailMessageId: params.emailMessageId,
          emailSubject: params.emailSubject,
          fieldValues: params.presetFields,
          source: 'email',
        },
        { enqueueJobs: false },
      );

    const zipcodeHints = await this.resolveZipcodeEnrichment({
      combinedText: params.text,
      emailSubject: params.emailSubject,
      fieldValues: params.presetFields,
      detectedFields: det.detectedFields,
    });

    const enrichedDeterministicFieldValues = this.mergeMissingFieldValues(
      this.mergeMissingFieldValues(params.presetFields, det.detectedFields),
      zipcodeHints,
    );

    const baseValidation =
      zipcodeHints.length > 0 || Object.keys(params.presetFields).length > 0
        ? await this.transportBookingValidationService.validateOrderFromFieldValues(
            {
              orderId: params.orderId,
              emailMessageId: params.emailMessageId,
              emailSubject: params.emailSubject,
              fieldValues: enrichedDeterministicFieldValues,
              source: 'email',
              fieldMetaByKey: this.buildProfileFieldMeta(
                params.presetFields,
                enrichedDeterministicFieldValues,
              ),
            },
            { enqueueJobs: false },
          )
        : det;

    const metrics = this.buildAiDecisionMetrics({
      requiredMissingCount: baseValidation.missingFields.length,
      recommendedMissingCount: baseValidation.validationWarnings?.length ?? 0,
      detectedFieldCount: baseValidation.detectedFields.filter(
        (f) => f?.key && !this.aiExcludeKeys.has(f.key),
      ).length,
      overallConfidence: baseValidation.overallConfidence,
    });

    // 2) Deterministic already sufficient -> done (no AI call).
    if (!this.shouldUseAiExtraction(metrics)) {
      if (params.enqueueJobs) {
        await this.transportBookingValidationService.enqueueJobsForOrder({
          orderId: params.orderId,
          emailMessageId: params.emailMessageId,
        });
      }
      return;
    }

    // 3) Fill the gaps via the configured AI extraction route.
    const profile = this.clientProfileService.resolve({
      fromEmail: params.fromEmail,
      bodyText: params.bodyText,
      text: params.text,
    });
    const aiPayload = {
      orderId: params.orderId,
      customerEmail: params.customerEmail,
      subject: params.emailSubject || null,
      bodyText: params.bodyText,
      attachmentsText: null,
      combinedText: params.text,
      requiredFields: TRANSPORT_BOOKING_FIELD_RULES,
      detectedFields: this.mergeDetectedFields(
        baseValidation.detectedFields.filter(
          (f) => f?.key && !this.aiExcludeKeys.has(f.key),
        ),
        [
          ...this.toProfileDetectedFields(params.presetFields),
          ...zipcodeHints,
        ],
      ),
      missingFields: baseValidation.missingFields,
      department: params.department,
      language: params.language || this.detectLanguage(params.text),
      emailMetadata: {
        fromEmail: params.fromEmail,
        fromName: params.fromName,
        receivedAt: params.receivedAt,
      },
      clientProfile: profile
        ? this.clientProfileService.payloadSummary(profile)
        : null,
    };

    const aiResult = await this.aiExtractionService.extract(aiPayload);
    await this.recordAiExtractionRequest({
      orderId: params.orderId,
      payload: aiPayload,
      aiResult,
    });

    if (aiResult?.fields) {
      // AI fills gaps; client-profile preset fields stay authoritative.
      const merged = { ...aiResult.fields } as Record<string, unknown>;
      for (const d of baseValidation.detectedFields) {
        if (!d?.key || merged[d.key] != null || !d.value) continue;
        merged[d.key] = d.value;
      }
      Object.assign(merged, params.presetFields);
      Object.assign(merged, this.mergeMissingFieldValues({}, zipcodeHints));
      // Route "deliver/load until X" times to the *_time_till slot.
      const routed = routeTimeBounds(merged, params.text);
      await this.transportBookingValidationService.validateOrderFromFieldValues(
          {
            orderId: params.orderId,
            emailMessageId: params.emailMessageId,
            emailSubject: params.emailSubject,
            fieldValues: routed,
            source: 'ai',
            fieldMetaByKey: this.buildProfileFieldMeta(
              params.presetFields,
              routed,
            ),
          },
          { enqueueJobs: params.enqueueJobs },
        );
    } else if (params.enqueueJobs) {
      await this.transportBookingValidationService.enqueueJobsForOrder({
        orderId: params.orderId,
        emailMessageId: params.emailMessageId,
      });
    }
  }

  /** Whether batch orders should auto-enqueue XML/reply jobs (off by default). */
  private batchEnqueueJobsEnabled(): boolean {
    const raw = (
      this.configService.get<string>('BATCH_ENQUEUE_JOBS_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  /** New flow: the AI works from the .eml and returns the orders; we only store. */
  private aiEmailAnalysisEnabled(): boolean {
    const raw = (
      this.configService.get<string>('AI_EMAIL_ANALYSIS_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  /**
   * NEW FLOW. Send the raw .eml to the AI, then store whatever it returns:
   * the classification + the order(s) (1 or many). No extraction/split on our
   * side. If the AI is unavailable we throw (email goes FAILED, never lost).
   */
  private async processViaAiAnalysis(email: {
    id: string;
    fromEmail: string;
    fromName: string | null;
    subject: string;
    bodyText?: string | null;
    bodyHtml?: string | null;
    attachments?: Array<{ fileName?: string | null; extractedText?: string | null }>;
    mailbox: { department: Department };
  }): Promise<void> {
    const eml = (email as any).rawMimeBase64 ?? null;
    const combinedText = this.buildCombinedText({
      subject: email.subject,
      bodyText: email.bodyText ?? null,
      bodyHtml: email.bodyHtml ?? null,
      attachments: (email.attachments ?? []).map((attachment) => ({
        fileName: attachment.fileName ?? '',
        extractedText: attachment.extractedText ?? null,
      })),
    });
    const clientProfile = this.clientProfileService.resolve({
      fromEmail: email.fromEmail,
      bodyText: email.bodyText ?? null,
      text: combinedText,
    });
    const profileFields = clientProfile
      ? this.clientProfileService.derive(clientProfile, combinedText)
      : {};
    const preDetectedZipcodes = await this.resolveZipcodeEnrichment({
      combinedText,
      emailSubject: email.subject,
      fieldValues: profileFields,
    });
    const analysis = await this.aiExtractionService.analyzeEmail(eml, {
      detectedFields: [
        ...this.toProfileDetectedFields(profileFields),
        ...preDetectedZipcodes,
      ],
    });
    if (!analysis) {
      throw new Error(`AI analysis returned null for emailMessageId=${email.id}`);
    }
    // Preview of what we POST to /eml-process (the full base64 would bloat the
    // DB; the field name + size + a head sample are enough for debugging).
    const emlPreview = eml
      ? `${String(eml).slice(0, 120)}…(${String(eml).length} bytes)`
      : null;

    await this.prismaService.emailMessage.update({
      where: { id: email.id },
      data: {
        isTransportOrder: analysis.isTransportOrder,
        classificationReason: analysis.reason,
        classificationLanguage: analysis.language,
        classifiedAt: new Date(),
      },
    });
    await this.auditLogService.log({
      entityType: 'EmailMessage',
      entityId: email.id,
      action: 'AI_CLASSIFICATION_COMPLETED',
      detailsJson: {
        isTransportOrder: analysis.isTransportOrder,
        confidence: analysis.confidence,
        reason: analysis.reason,
        language: analysis.language,
        orderCount: analysis.orders.length,
      },
    });

    if (!analysis.isTransportOrder || analysis.orders.length === 0) {
      await this.auditLogService.log({
        entityType: 'EmailMessage',
        entityId: email.id,
        action: analysis.isTransportOrder
          ? 'EMAIL_NO_ORDERS'
          : 'EMAIL_IGNORED_NOT_TRANSPORT',
        detailsJson: { reason: analysis.reason },
      });
      await this.prismaService.emailMessage.update({
        where: { id: email.id },
        data: { status: EmailStatus.PROCESSED },
      });
      this.logger.log(
        `Email ${email.id}: not a transport order / no orders (AI)`,
      );
      return;
    }

    const isBatch = analysis.orders.length > 1;
    const batch = isBatch
      ? await this.prismaService.batchImport.create({
          data: {
            emailMessageId: email.id,
            status: BatchImportStatus.PROCESSING,
            totalDetected: analysis.orders.length,
            confidence: analysis.confidence,
            reason: analysis.reason,
          },
        })
      : null;
    if (batch) {
      await this.auditLogService.log({
        entityType: 'BatchImport',
        entityId: batch.id,
        action: 'BATCH_IMPORT_CREATED',
        detailsJson: { source: 'ai', totalDetected: analysis.orders.length },
      });
    }

    // Single orders enqueue their own job (reply or XML). Batch orders do NOT
    // enqueue per-order reply jobs here — that would send one e-mail PER order.
    // Instead, after all orders exist, we send ONE consolidated reply for the
    // whole batch (below) and enqueue XML only for the orders that are complete.
    const enqueueJobs = isBatch ? false : true;
    let created = 0;
    let failed = 0;
    let seq = 0;

    for (const o of analysis.orders) {
      seq++;
      try {
        const extRef = o.externalReference || null;
        // Idempotency: by external reference, or (single) the primary order.
        const existing = extRef
          ? await this.prismaService.transportOrder.findFirst({
              where: { emailMessageId: email.id, externalReference: extRef },
              select: { id: true },
            })
          : isBatch
            ? null
            : await this.prismaService.transportOrder.findFirst({
                where: { emailMessageId: email.id, batchImportId: null },
                select: { id: true },
              });

        let orderId: string;
        if (existing) {
          orderId = existing.id;
        } else {
          const order = await this.prismaService.transportOrder.create({
            data: {
              emailMessageId: email.id,
              batchImportId: batch?.id ?? null,
              batchSequence: isBatch ? seq : null,
              externalReference: extRef,
              department: email.mailbox.department,
              type: OrderType.NEW_ORDER,
              status: OrderStatus.PROCESSING,
              customerEmail: email.fromEmail,
              customerName: email.fromName || null,
            },
          });
          orderId = order.id;
        }

        const profileMergedFields = this.mergeMissingFieldValues(
          o.fields,
          this.toProfileDetectedFields(profileFields),
        );
        const preMergedFields =
          analysis.orders.length === 1
            ? this.mergeMissingFieldValues(profileMergedFields, preDetectedZipcodes)
            : profileMergedFields;
        const orderZipcodeHints = await this.resolveZipcodeEnrichment({
          fieldValues: preMergedFields,
        });
        const finalFields = this.mergeMissingFieldValues(
          preMergedFields,
          orderZipcodeHints,
        );

        await this.transportBookingValidationService.validateOrderFromFieldValues(
          {
            orderId,
            emailMessageId: email.id,
            emailSubject: email.subject ?? '',
            fieldValues: finalFields,
            source: 'ai',
            fieldMetaByKey: this.buildProfileFieldMeta(profileFields, finalFields),
          },
          { enqueueJobs },
        );

        // Record the /eml-process call on this order so the panel ("Advanced ->
        // AI requests") shows what we sent and what the AI returned.
        await this.prismaService.aiRequest
          .create({
            data: {
              orderId,
              payloadJson: {
                route: 'eml-process',
                request: {
                  emlBase64: emlPreview,
                  emailSubject: email.subject,
                  emailMessageId: email.id,
                  detectedFields: [
                    ...this.toProfileDetectedFields(profileFields),
                    ...preDetectedZipcodes,
                  ],
                  clientProfile: clientProfile
                    ? this.clientProfileService.payloadSummary(clientProfile)
                    : null,
                },
              } as any,
              responseJson: (analysis.rawResponse ?? analysis) as any,
              status: 'SUCCEEDED',
            },
          })
          .catch(() => undefined);
        created++;
      } catch (err: any) {
        failed++;
        this.logger.warn(`AI order failed seq=${seq}: ${err?.message ?? err}`);
      }
    }

    if (batch) {
      await this.prismaService.batchImport.update({
        where: { id: batch.id },
        data: {
          status:
            failed === 0
              ? BatchImportStatus.COMPLETED
              : created > 0
                ? BatchImportStatus.PARTIAL_FAILED
                : BatchImportStatus.FAILED,
          totalCreated: created,
          totalFailed: failed,
        },
      });

      // ONE consolidated reply for the whole batch (all missing fields, grouped
      // by order) instead of one e-mail per order. Always produce the draft so
      // the operator can review/send it. XML for the orders that ARE complete is
      // only auto-enqueued when the batch-jobs flag is on.
      await this.aiReplyService
        .generateConsolidatedMissingInfoReply(batch.id)
        .catch((err: any) =>
          this.logger.warn(
            `Consolidated reply draft failed batchId=${batch.id}: ${err?.message ?? err}`,
          ),
        );

      if (this.batchEnqueueJobsEnabled()) {
        const batchOrders = await this.prismaService.transportOrder.findMany({
          where: { batchImportId: batch.id },
          select: { id: true, status: true },
        });
        for (const bo of batchOrders) {
          if (bo.status === OrderStatus.READY_TO_XML) {
            await this.transportBookingValidationService
              .enqueueJobsForOrder({ orderId: bo.id, emailMessageId: email.id })
              .catch((err: any) =>
                this.logger.warn(
                  `Batch XML enqueue failed orderId=${bo.id}: ${err?.message ?? err}`,
                ),
              );
          }
        }
      }
    }

    await this.prismaService.emailMessage.update({
      where: { id: email.id },
      data: { status: EmailStatus.PROCESSED },
    });
    await this.auditLogService.log({
      entityType: 'EmailMessage',
      entityId: email.id,
      action: 'EMAIL_PROCESSED_VIA_AI',
      detailsJson: {
        orders: analysis.orders.length,
        created,
        failed,
        batch: isBatch,
      },
    });
    this.logger.log(
      `Email ${email.id} processed via AI: ${created} order(s), ${failed} failed`,
    );
  }

  /**
   * NEW FLOW — customer reply. Send the reply's .eml to the AI and merge what it
   * returns into the existing order, NON-DESTRUCTIVELY (the reply can fill the
   * missing info but never clears data already present).
   */
  private async processReplyViaAiAnalysis(params: {
    replyEmailMessage: any;
    existingOrder: any;
    linkMatchType: EmailLinkMethod;
  }): Promise<void> {
    const { replyEmailMessage, existingOrder, linkMatchType } = params;
    const combinedText = this.buildCombinedText({
      subject: replyEmailMessage.subject ?? null,
      bodyText: replyEmailMessage.bodyText ?? null,
      bodyHtml: replyEmailMessage.bodyHtml ?? null,
      attachments: (replyEmailMessage.attachments ?? []).map((attachment: any) => ({
        fileName: attachment.fileName ?? '',
        extractedText: attachment.extractedText ?? null,
      })),
    });
    const preDetectedZipcodes = await this.resolveZipcodeEnrichment({
      combinedText,
      emailSubject: replyEmailMessage.subject ?? null,
    });
    const analysis = await this.aiExtractionService.analyzeEmail(
      replyEmailMessage.rawMimeBase64 ?? null,
      {
        detectedFields: preDetectedZipcodes,
      },
    );
    if (!analysis) {
      throw new Error(
        `AI analysis returned null for reply emailMessageId=${replyEmailMessage.id}`,
      );
    }

    // Link the reply to the existing order.
    await this.prismaService.emailMessage.update({
      where: { id: replyEmailMessage.id },
      data: { linkedOrderId: existingOrder.id, linkedByMethod: linkMatchType },
    });
    await this.prismaService.transportOrder.update({
      where: { id: existingOrder.id },
      data: { lastCustomerReplyAt: new Date() },
    });
    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: existingOrder.id,
      action: 'CUSTOMER_REPLY_LINKED',
      detailsJson: {
        replyEmailMessageId: replyEmailMessage.id,
        method: linkMatchType,
      },
    });

    // Distribute the reply across the order(s). A consolidated batch reply can
    // return several orders (one per reference) — each is merged into the order
    // it belongs to, matched by externalReference. The merge is NON-DESTRUCTIVE:
    // existing values are kept; the reply only fills gaps.
    const isBatchReply = Boolean(existingOrder.batchImportId);
    const targets: any[] = isBatchReply
      ? await this.prismaService.transportOrder.findMany({
          where: { batchImportId: existingOrder.batchImportId },
          include: { fields: true, emailMessage: true },
        })
      : [existingOrder];

    const byRef = new Map<string, any>();
    for (const t of targets) {
      const ref = (t.externalReference ?? '').toString().trim();
      if (ref) byRef.set(ref, t);
    }
    const resolveTarget = (extRef: string | null | undefined) => {
      const ref = (extRef ?? '').toString().trim();
      if (ref && byRef.has(ref)) return byRef.get(ref);
      if (targets.length === 1) return targets[0];
      return existingOrder; // anchor fallback for an unreferenced answer
    };
    const seedFromExisting = (order: any): Record<string, unknown> => {
      const m: Record<string, unknown> = {};
      for (const f of order.fields ?? []) {
        const v = (f.value ?? '').toString().trim();
        if (v) m[f.key] = v;
      }
      return m;
    };

    const pending = new Map<
      string,
      { order: any; fields: Record<string, unknown> }
    >();
    const returned = analysis.orders.length ? analysis.orders : [{ fields: {} }];
    for (const ao of returned) {
      const target = resolveTarget((ao as any).externalReference);
      let entry = pending.get(target.id);
      if (!entry) {
        entry = { order: target, fields: seedFromExisting(target) };
        pending.set(target.id, entry);
      }
      const aiFields =
        analysis.orders.length === 1
          ? this.mergeMissingFieldValues(
              (ao as any).fields ?? {},
              preDetectedZipcodes,
            )
          : ((ao as any).fields ?? {});
      const orderZipcodeHints = await this.resolveZipcodeEnrichment({
        fieldValues: aiFields,
      });
      const enrichedAiFields = this.mergeMissingFieldValues(
        aiFields,
        orderZipcodeHints,
      );
      for (const [k, v] of Object.entries(enrichedAiFields)) {
        if (!entry.fields[k] && v != null && v.toString().trim() !== '') {
          entry.fields[k] = v;
        }
      }
    }

    // For a batch reply we don't enqueue per-order jobs (that would re-send one
    // e-mail per still-incomplete order); we re-run the consolidated step below.
    for (const { order, fields } of pending.values()) {
      await this.transportBookingValidationService.validateOrderFromFieldValues(
        {
          orderId: order.id,
          emailMessageId: order.emailMessageId,
          emailSubject:
            order.emailMessage?.subject ??
            existingOrder.emailMessage?.subject ??
            '',
          fieldValues: fields,
          source: 'ai',
        },
        { enqueueJobs: !isBatchReply },
      );
    }

    if (isBatchReply) {
      // Follow-up: one consolidated reply for whatever is STILL missing, plus
      // XML for the orders that are now complete (gated by the batch flag).
      await this.aiReplyService
        .generateConsolidatedMissingInfoReply(existingOrder.batchImportId)
        .catch((err: any) =>
          this.logger.warn(
            `Consolidated follow-up reply failed batchId=${existingOrder.batchImportId}: ${err?.message ?? err}`,
          ),
        );
      if (this.batchEnqueueJobsEnabled()) {
        const batchOrders = await this.prismaService.transportOrder.findMany({
          where: { batchImportId: existingOrder.batchImportId },
          select: { id: true, status: true, emailMessageId: true },
        });
        for (const bo of batchOrders) {
          if (bo.status === OrderStatus.READY_TO_XML) {
            await this.transportBookingValidationService
              .enqueueJobsForOrder({
                orderId: bo.id,
                emailMessageId: bo.emailMessageId,
              })
              .catch(() => undefined);
          }
        }
      }
    }

    // Record the /eml-process call (reply) on the order for the panel.
    const replyEml = replyEmailMessage.rawMimeBase64 ?? null;
    await this.prismaService.aiRequest
      .create({
        data: {
          orderId: existingOrder.id,
          payloadJson: {
            route: 'eml-process',
            context: 'customer-reply',
            request: {
              emlBase64: replyEml
                ? `${String(replyEml).slice(0, 120)}…(${String(replyEml).length} bytes)`
                : null,
              replyEmailMessageId: replyEmailMessage.id,
              detectedFields: preDetectedZipcodes,
            },
          } as any,
          responseJson: (analysis.rawResponse ?? analysis) as any,
          status: 'SUCCEEDED',
        },
      })
      .catch(() => undefined);

    await this.prismaService.emailMessage.update({
      where: { id: replyEmailMessage.id },
      data: { status: EmailStatus.PROCESSED },
    });
    this.logger.log(
      `Reply ${replyEmailMessage.id} processed via AI -> order ${existingOrder.id}`,
    );
  }

  /**
   * Apply the client-profile deterministic fields (merged over the deterministic
   * detection) when the AI path is not taken. Returns false if there is nothing
   * to apply, so the caller can fall back to plain job enqueuing.
   */
  private async applyProfileFields(params: {
    orderId: string;
    emailMessageId: string;
    emailSubject: string;
    detectedFields: Array<{ key?: string; value?: string | null }>;
    profileFields: Record<string, string>;
    combinedText: string;
  }): Promise<boolean> {
    if (Object.keys(params.profileFields).length === 0) return false;
    const fieldValues: Record<string, unknown> = {};
    for (const d of params.detectedFields) {
      if (d?.key && d.value) fieldValues[d.key] = d.value;
    }
    // Profile fields are authoritative.
    Object.assign(fieldValues, params.profileFields);
    await this.transportBookingValidationService.validateOrderFromFieldValues(
      {
        orderId: params.orderId,
        emailMessageId: params.emailMessageId,
        emailSubject: params.emailSubject,
        fieldValues: routeTimeBounds(fieldValues, params.combinedText),
        source: 'email',
        fieldMetaByKey: this.buildProfileFieldMeta(
          params.profileFields,
          fieldValues,
        ),
      },
      { enqueueJobs: true },
    );
    return true;
  }

  /**
   * Turn a detected batch into N TransportOrders under a BatchImport. Each order
   * carries its own rawOrderText + the deterministic profile-derived fields.
   * Idempotent on (emailMessageId, externalReference) so reprocessing is safe.
   * Jobs are NOT enqueued here — operators review the batch in the panel.
   */
  private async handleBatch(
    email: {
      id: string;
      fromEmail: string;
      fromName: string | null;
      subject: string;
      bodyText: string | null;
      receivedAt: Date | null;
      classificationLanguage: string | null;
      mailbox: { department: Department };
    },
    classification: { type: OrderType; originalOrderReference?: string | null },
    split: SplitResult,
  ): Promise<void> {
    const enqueueJobs = this.batchEnqueueJobsEnabled();
    const profile = this.clientProfileService.resolve({
      fromEmail: email.fromEmail,
      bodyText: email.bodyText,
      text: split.orders.map((o) => o.rawText).join('\n'),
    });
    const customerName = profile?.name ?? email.fromName ?? null;

    const batch = await this.prismaService.batchImport.create({
      data: {
        emailMessageId: email.id,
        status: BatchImportStatus.PROCESSING,
        totalDetected: split.orders.length,
        reason: split.reason,
      },
    });

    await this.auditLogService.log({
      entityType: 'BatchImport',
      entityId: batch.id,
      action: 'BATCH_IMPORT_CREATED',
      detailsJson: { source: split.source, totalDetected: split.orders.length },
    });

    let created = 0;
    let failed = 0;

    for (const chunk of split.orders) {
      try {
        // Idempotency: don't duplicate an order already imported for this email.
        const existing = chunk.externalReference
          ? await this.prismaService.transportOrder.findFirst({
              where: {
                emailMessageId: email.id,
                externalReference: chunk.externalReference,
              },
              select: { id: true },
            })
          : null;
        if (existing) {
          created++;
          continue;
        }

        const order = await this.prismaService.transportOrder.create({
          data: {
            emailMessageId: email.id,
            batchImportId: batch.id,
            batchSequence: chunk.sequence,
            externalReference: chunk.externalReference,
            rawOrderText: chunk.rawText,
            department: email.mailbox.department,
            type: classification.type,
            status: OrderStatus.PROCESSING,
            customerEmail: email.fromEmail,
            customerName,
            originalOrderReference:
              classification.originalOrderReference ?? null,
          },
        });

        // Process the order through the SAME fill-in pipeline as a single
        // order: deterministic preset (profile) + AI route to fill the gaps.
        await this.fillOrder({
          orderId: order.id,
          emailMessageId: email.id,
          emailSubject: email.subject,
          text: chunk.rawText,
          presetFields: chunk.derivedFields,
          department: email.mailbox.department,
          customerEmail: email.fromEmail,
          fromEmail: email.fromEmail,
          fromName: email.fromName,
          receivedAt: email.receivedAt,
          bodyText: email.bodyText,
          language: email.classificationLanguage,
          enqueueJobs,
        });
        created++;
      } catch (err: any) {
        failed++;
        this.logger.warn(
          `Batch order failed seq=${chunk.sequence}: ${err?.message ?? err}`,
        );
      }
    }

    await this.prismaService.batchImport.update({
      where: { id: batch.id },
      data: {
        status:
          failed === 0
            ? BatchImportStatus.COMPLETED
            : created > 0
              ? BatchImportStatus.PARTIAL_FAILED
              : BatchImportStatus.FAILED,
        totalCreated: created,
        totalFailed: failed,
      },
    });

    await this.prismaService.emailMessage.update({
      where: { id: email.id },
      data: { status: EmailStatus.PROCESSED },
    });

    await this.auditLogService.log({
      entityType: 'EmailMessage',
      entityId: email.id,
      action: 'BATCH_IMPORT_COMPLETED',
      detailsJson: {
        batchId: batch.id,
        source: split.source,
        totalDetected: split.orders.length,
        created,
        failed,
      },
    });

    this.logger.log(
      `Batch import ${batch.id}: ${created} created, ${failed} failed (source=${split.source})`,
    );
  }

  private parseProviderMessageId(graphMessageId: string) {
    const raw = (graphMessageId || '').trim();
    const idx = raw.indexOf(':');
    if (idx > 0) {
      return { provider: raw.slice(0, idx), id: raw.slice(idx + 1) };
    }
    return { provider: null, id: raw };
  }

  private async downloadGraphAttachmentsIfNeeded(emailMessage: any) {
    if (!emailMessage?.hasAttachments) return;
    const parsed = this.parseProviderMessageId(emailMessage.graphMessageId);
    // Only IMAP messages must be skipped here; an unprefixed id is treated as Graph.
    if (parsed.provider && parsed.provider !== 'graph') return;

    const graphMessageId = parsed.id;
    if (!graphMessageId) return;

    const mailboxEmail = emailMessage.mailbox?.email as string | undefined;
    if (!mailboxEmail) return;

    const attachments = await this.graphService.getMessageAttachments(
      mailboxEmail,
      graphMessageId,
    );
    if (!attachments.length) return;

    // Upsert each attachment so that rows created earlier WITHOUT content (e.g.
    // a failed content download) get backfilled on (re)processing instead of
    // being skipped. When new content arrives we reset extraction so the text
    // is parsed again.
    for (const a of attachments) {
      if (!a.providerAttachmentId) continue;

      const base = {
        fileName: a.fileName,
        mimeType: a.mimeType ?? 'application/octet-stream',
        size: a.size ?? 0,
      };

      await this.prismaService.attachment.upsert({
        where: {
          emailMessageId_graphAttachmentId: {
            emailMessageId: emailMessage.id,
            graphAttachmentId: a.providerAttachmentId,
          },
        },
        create: {
          emailMessageId: emailMessage.id,
          graphAttachmentId: a.providerAttachmentId,
          ...base,
          contentBase64: a.contentBase64 ?? null,
        },
        update: a.contentBase64
          ? {
              ...base,
              contentBase64: a.contentBase64,
              extractedText: null,
              extractionMethod: null,
              extractionStatus: AttachmentExtractionStatus.PENDING,
            }
          : {},
      });
    }
  }

  private async extractAttachmentTextIfNeeded(emailMessage: any) {
    // New flow: the AI parses the .eml (incl. attachments) on its side, so our
    // OCR/text extraction is redundant. We still download/store the attachment
    // bytes for the panel — only the costly text extraction is skipped here.
    if (this.aiEmailAnalysisEnabled()) return;

    const attachments = (emailMessage?.attachments ?? []) as Array<{
      id: string;
      extractedText?: string | null;
    }>;
    if (!attachments.length) return;

    for (const att of attachments) {
      if (!att?.id) continue;
      if (att.extractedText && att.extractedText.trim()) continue;
      await this.attachmentParserService.extractTextFromAttachment(att.id);
    }
  }

  private buildCombinedText(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    attachments?: Array<{ fileName: string; extractedText: string | null }>;
  }) {
    const parts: string[] = [];
    if (input.subject) parts.push(`Subject:\n${input.subject}`);
    if (input.bodyText) parts.push(`BodyText:\n${input.bodyText}`);
    if (input.bodyHtml) parts.push(`BodyHtml:\n${input.bodyHtml}`);

    const attachmentParts =
      input.attachments
        ?.map((a) => {
          const lines: string[] = [];
          if (a.fileName) lines.push(`AttachmentFileName: ${a.fileName}`);
          if (a.extractedText) {
            lines.push(`AttachmentExtractedText:\n${a.extractedText}`);
          }
          return lines.join('\n');
        })
        .filter((x) => x.trim().length > 0) ?? [];

    if (attachmentParts.length) {
      parts.push(attachmentParts.join('\n\n'));
    }

    return parts.join('\n\n');
  }

  private toMergeableFieldsFromOrder(order: any): MergeableField[] {
    return (order?.fields ?? [])
      .filter(
        (field: any) => sanitizeExtractedValue(field?.value ?? '').length > 0,
      )
      .map((field: any) => ({
        key: field.key,
        value: field.value,
        confidence: field.confidence ?? 0.95,
        source: field.source ?? 'EMAIL',
      }));
  }

  private toMergeableFieldsFromDetected(
    detectedFields: Array<{ key: string; value: string; confidence: number }>,
    source: MergeableField['source'],
  ): MergeableField[] {
    return (detectedFields ?? [])
      .filter(
        (field) =>
          field?.key && sanitizeExtractedValue(field.value ?? '').length > 0,
      )
      .map((field) => ({
        key: field.key,
        value: field.value,
        confidence: field.confidence ?? (source === 'AI' ? 0.85 : 0.95),
        source,
      }));
  }

  private buildFieldPayload(mergedFields: MergeableField[]) {
    const merged = this.fieldMergeService.merge(mergedFields);
    const fieldValues: Record<string, unknown> = {};
    const fieldMetaByKey: Record<
      string,
      { confidence?: number | null; source?: OrderFieldSource }
    > = {};

    for (const field of merged) {
      const value = sanitizeExtractedValue(field.value ?? '');
      if (!field.key || !value) continue;
      fieldValues[field.key] = value;
      fieldMetaByKey[field.key] = {
        confidence: field.confidence,
        source: field.source as OrderFieldSource,
      };
    }

    return { fieldValues, fieldMetaByKey, mergedFields: merged };
  }

  private async processCustomerReply(params: {
    replyEmailMessage: any;
    existingOrder: any;
    linkMatchType: EmailLinkMethod;
  }) {
    const { replyEmailMessage, existingOrder, linkMatchType } = params;

    // Link this incoming email to the existing order and re-validate using original + reply content.
    await this.prismaService.emailMessage.update({
      where: { id: replyEmailMessage.id },
      data: {
        linkedOrderId: existingOrder.id,
        linkedByMethod: linkMatchType,
      },
    });

    const previousMissing = existingOrder.missingFields || [];

    await this.prismaService.$transaction(async (tx) => {
      await tx.xmlDelivery.deleteMany({
        where: {
          orderId: existingOrder.id,
          status: { in: ['PENDING', 'FAILED'] },
        },
      });
      await tx.transportOrder.update({
        where: { id: existingOrder.id },
        data: { status: OrderStatus.PROCESSING, overallConfidence: null },
      });
    });

    const linkedReplies = await this.prismaService.emailMessage.findMany({
      where: { linkedOrderId: existingOrder.id },
      include: { attachments: true },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });

    const contextEmails = [
      existingOrder.emailMessage,
      ...linkedReplies.filter(
        (email: any) => email.id !== existingOrder.emailMessage.id,
      ),
    ];

    const mergedText = contextEmails
      .map((email: any) =>
        this.buildCombinedText({
          subject: email.subject,
          bodyText: email.bodyText,
          bodyHtml: email.bodyHtml,
          attachments: (email.attachments || []).map((attachment: any) => ({
            fileName: attachment.fileName,
            extractedText: attachment.extractedText,
          })),
        }),
      )
      .filter(Boolean)
      .join('\n\n---\n\n');

    const deterministic = await this.requiredFieldsService.validateEmailContent(
      existingOrder.emailMessage as any,
      mergedText,
      { enqueueJobs: false },
    );

    // Contextual handling for short replies:
    // If the order was waiting and exactly 1 field was missing, treat the reply body as that field's value.
    const replyRaw =
      (replyEmailMessage.bodyText || '').toString().trim() ||
      (replyEmailMessage.bodyHtml || '').toString().trim();
    const replyText = sanitizeExtractedValue(replyRaw);
    const isShort =
      replyText.length > 0 &&
      replyText.length <= 80 &&
      !replyText.includes('\n');
    const isSingleMissing =
      existingOrder.status === OrderStatus.WAITING_CUSTOMER_RESPONSE &&
      previousMissing.length === 1;

    if (isSingleMissing && isShort) {
      const only = previousMissing[0];
      if (only?.key) {
        deterministic.detectedFields.push({
          key: only.key,
          label: only.label,
          value: replyText,
          confidence: 0.9,
        });
        deterministic.missingFields = deterministic.missingFields.filter(
          (m) => m.key !== only.key,
        );
      }
    }

    const attachmentsTextMerged = contextEmails
      .flatMap((email: any) => email.attachments || [])
      .map((attachment: any) =>
        (attachment.extractedText || '').toString().trim(),
      )
      .filter((text: string) => text.length > 0)
      .join('\n\n');

    const zipcodeHints = await this.resolveZipcodeEnrichment({
      combinedText: mergedText,
      emailSubject: existingOrder.emailMessage.subject ?? '',
      detectedFields: [
        ...deterministic.detectedFields,
        ...(existingOrder.fields ?? []).map((field: any) => ({
          key: field.key,
          label: field.label,
          value: field.value,
          confidence: field.confidence,
          source: field.source,
        })),
      ],
    });

    const mergedDeterministic = this.buildFieldPayload([
      ...this.toMergeableFieldsFromOrder(existingOrder),
      ...this.toMergeableFieldsFromDetected(
        deterministic.detectedFields,
        'EMAIL',
      ),
      ...this.toMergeableFieldsFromDetected(zipcodeHints, 'EMAIL'),
    ]);

    const baseValidation =
      zipcodeHints.length > 0
        ? await this.transportBookingValidationService.validateOrderFromFieldValues(
            {
              orderId: existingOrder.id,
              emailMessageId: replyEmailMessage.id,
              emailSubject: existingOrder.emailMessage.subject ?? '',
              fieldValues: mergedDeterministic.fieldValues,
              fieldMetaByKey: mergedDeterministic.fieldMetaByKey,
              source: 'email',
            },
            { enqueueJobs: false },
          )
        : deterministic;

    const aiDecisionMetrics = this.buildAiDecisionMetrics({
      requiredMissingCount: baseValidation.missingFields.length,
      recommendedMissingCount:
        baseValidation.validationWarnings?.length ?? 0,
      detectedFieldCount: baseValidation.detectedFields.filter(
        (field) => field?.key && !this.aiExcludeKeys.has(field.key),
      ).length,
      overallConfidence: baseValidation.overallConfidence,
    });
    const shouldAi = this.shouldUseAiExtraction(aiDecisionMetrics);

    let finalValidation;

    if (shouldAi) {
      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: existingOrder.id,
        action: 'AI_AUTO_PROCESSING_TRIGGERED',
        detailsJson: {
          context: 'customer_reply',
          linkedEmailMessageId: replyEmailMessage.id,
          ...aiDecisionMetrics,
        },
      });

      const aiPayload = {
        orderId: existingOrder.id,
        customerEmail: existingOrder.customerEmail ?? null,
        subject: existingOrder.emailMessage.subject ?? null,
        bodyText: existingOrder.emailMessage.bodyText ?? null,
        attachmentsText: attachmentsTextMerged || null,
        combinedText: mergedText,
        requiredFields: TRANSPORT_BOOKING_FIELD_RULES,
        detectedFields: mergedDeterministic.mergedFields
          .filter((field) => field?.key && !this.aiExcludeKeys.has(field.key))
          .map((field) => ({
            key: field.key,
            label:
              baseValidation.detectedFields.find(
                (item) => item.key === field.key,
              )?.label ?? field.key,
            value: field.value ?? '',
            confidence: field.confidence ?? 0,
          })),
        missingFields: baseValidation.missingFields,
        department: existingOrder.department ?? null,
        language: this.detectLanguage(mergedText),
        emailMetadata: {
          fromEmail: existingOrder.emailMessage.fromEmail ?? null,
          fromName: existingOrder.emailMessage.fromName ?? null,
          receivedAt: existingOrder.emailMessage.receivedAt ?? null,
          linkedReplyEmailMessageId: replyEmailMessage.id,
          customerEmail: existingOrder.customerEmail ?? null,
        },
      };
      const aiResult = await this.aiExtractionService.extract(aiPayload);
      await this.recordAiExtractionRequest({
        orderId: existingOrder.id,
        payload: aiPayload,
        aiResult,
      });

      const mergedWithAi = this.buildFieldPayload([
        ...mergedDeterministic.mergedFields,
        ...this.toMergeableFieldsFromDetected(
          Object.entries(aiResult?.fields ?? {}).map(([key, value]) => ({
            key,
            value: sanitizeExtractedValue(String(value ?? '')),
            confidence: 0.85,
          })),
          'AI',
        ),
      ]);

      finalValidation =
        await this.transportBookingValidationService.validateOrderFromFieldValues(
          {
            orderId: existingOrder.id,
            emailMessageId: replyEmailMessage.id,
            emailSubject: existingOrder.emailMessage.subject ?? '',
            fieldValues: mergedWithAi.fieldValues,
            fieldMetaByKey: mergedWithAi.fieldMetaByKey,
            source: 'email',
          },
          { enqueueJobs: true },
        );
    } else {
      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: existingOrder.id,
        action: 'AI_AUTO_PROCESSING_SKIPPED',
        detailsJson: {
          context: 'customer_reply',
          linkedEmailMessageId: replyEmailMessage.id,
          reason: 'Deterministic validation considered sufficient.',
          ...aiDecisionMetrics,
        },
      });

      finalValidation =
        await this.transportBookingValidationService.validateOrderFromFieldValues(
          {
            orderId: existingOrder.id,
            emailMessageId: replyEmailMessage.id,
            emailSubject: existingOrder.emailMessage.subject ?? '',
            fieldValues: mergedDeterministic.fieldValues,
            fieldMetaByKey: mergedDeterministic.fieldMetaByKey,
            source: 'email',
          },
          { enqueueJobs: true },
        );
    }

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: existingOrder.id,
      action: 'CUSTOMER_REPLY_LINKED',
      detailsJson: {
        linkedEmailMessageId: replyEmailMessage.id,
        matchType: linkMatchType,
      },
    });

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: existingOrder.id,
      action: 'LINK_METHOD_USED',
      detailsJson: {
        linkedEmailMessageId: replyEmailMessage.id,
        method: linkMatchType,
      },
    });

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: existingOrder.id,
      action: 'ORDER_UPDATED_FROM_REPLY',
        detailsJson: {
          linkedEmailMessageId: replyEmailMessage.id,
          missingFieldsAfter: finalValidation.missingFields.length,
          validationWarningsAfter:
            finalValidation.validationWarnings?.length ?? 0,
          shouldAi,
          aiDecisionMetrics,
        },
      });

    await this.prismaService.transportOrder.update({
      where: { id: existingOrder.id },
      data: { lastCustomerReplyAt: new Date() },
    });

    await this.prismaService.emailMessage.update({
      where: { id: replyEmailMessage.id },
      data: { status: EmailStatus.PROCESSED },
    });

    this.logger.log(
      `Linked reply emailMessageId=${replyEmailMessage.id} to existing orderId=${existingOrder.id} via ${linkMatchType}`,
    );
  }

  private detectLanguage(text: string) {
    const t = (text || '').toLowerCase();

    // Strong, transport-specific NL signal.
    if (
      /(laaddatum|losdatum|laadreferentie|losreferentie|laadtijd|lostijd)/.test(
        t,
      )
    )
      return 'nl';

    // Otherwise score common words per language (catches plain-prose emails).
    const count = (re: RegExp) => (t.match(re) || []).length;
    const nl = count(
      /\b(het|een|voor|met|niet|geachte|bijlage|vrijdag|groet|levering|afspraak|worden|zijn|naar|uur|ophalen|afleveren)\b/g,
    );
    const pt = count(
      /\b(para|n[ãa]o|com|endere[çc]o|entrega|coleta|sauda[çc][õo]es|anexo|favor|obrigado)\b/g,
    );
    const en = count(
      /\b(the|and|for|with|please|regards|attached|pickup|delivery|from|your|loading|unloading)\b/g,
    );

    const max = Math.max(nl, pt, en);
    if (max < 2) return 'unknown';
    if (nl === max) return 'nl';
    if (pt === max) return 'pt';
    return 'en';
  }

  private shouldUseAiExtraction(input: {
    requiredMissingCount: number;
    recommendedMissingCount: number;
    detectedFieldCount: number;
    overallConfidence: number;
  }) {
    return (
      input.requiredMissingCount > 0 ||
      input.recommendedMissingCount >= 5 ||
      input.detectedFieldCount < 12 ||
      input.overallConfidence < 0.85
    );
  }

  /**
   * Persist the AI extraction call as an AiRequest row so it shows up in the
   * order's "AI requests" panel. Best-effort: a failure here must never break
   * extraction itself.
   */
  private async recordAiExtractionRequest(params: {
    orderId: string;
    payload: unknown;
    aiResult: {fields?: Record<string, string>; rawResponse?: unknown} | null;
  }) {
    try {
      const fieldsCount = params.aiResult?.fields
        ? Object.keys(params.aiResult.fields).length
        : 0;
      await this.prismaService.aiRequest.create({
        data: {
          orderId: params.orderId,
          payloadJson: params.payload as any,
          responseJson: (params.aiResult?.rawResponse ??
            params.aiResult ??
            null) as any,
          status: params.aiResult
            ? fieldsCount > 0
              ? 'SUCCEEDED'
              : 'EMPTY'
            : 'FAILED',
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to record AI extraction request for orderId=${params.orderId}: ${err?.message ?? err}`,
      );
    }
  }

  private buildAiDecisionMetrics(input: {
    requiredMissingCount: number;
    recommendedMissingCount: number;
    detectedFieldCount: number;
    overallConfidence: number;
  }) {
    return {
      ...input,
      thresholds: {
        requiredMissingTriggersAi: input.requiredMissingCount > 0,
        recommendedMissingTriggersAi: input.recommendedMissingCount >= 5,
        lowDetectedFieldCountTriggersAi: input.detectedFieldCount < 12,
        lowConfidenceTriggersAi: input.overallConfidence < 0.85,
      },
    };
  }

  async process(job: Job): Promise<void> {
    const emailMessageId = job.data?.emailMessageId as string | undefined;
    if (!emailMessageId) {
      this.logger.warn(
        `Job missing emailMessageId: id=${job.id} data=${JSON.stringify(job.data)}`,
      );
      return;
    }

    const emailMessage = await this.prismaService.emailMessage.findUnique({
      where: { id: emailMessageId },
      include: { mailbox: true, attachments: true },
    });

    if (!emailMessage) {
      this.logger.warn(`EmailMessage not found: id=${emailMessageId}`);
      return;
    }

    if (emailMessage.hasAttachments) {
      await this.downloadGraphAttachmentsIfNeeded(emailMessage).catch(
        (err: any) => {
          this.logger.warn(
            `Attachment download skipped for emailMessageId=${emailMessage.id}: ${err?.message ?? err}`,
          );
        },
      );
    }

    // Refresh attachments after download (if any).
    const refreshed = await this.prismaService.emailMessage.findUnique({
      where: { id: emailMessage.id },
      include: { mailbox: true, attachments: true },
    });
    const emailForProcessing = refreshed ?? emailMessage;

    await this.extractAttachmentTextIfNeeded(emailForProcessing);

    // Refresh again to ensure extractedText is loaded.
    const withExtracted = await this.prismaService.emailMessage.findUnique({
      where: { id: emailForProcessing.id },
      include: { mailbox: true, attachments: true },
    });
    const emailForValidation = withExtracted ?? emailForProcessing;

    // Department gate: this pipeline only handles OPEN_TRANSPORT mailboxes.
    // Other departments (e.g. STUK_GOED) are still synced and stored, but parked
    // here until their own pipeline exists — no TransportOrder is created. The
    // mailbox is included on the query; if it's somehow missing we let it proceed
    // (never drop an email because of this gate).
    const mailboxDepartment = emailForValidation.mailbox?.department;
    if (mailboxDepartment && mailboxDepartment !== Department.OPEN_TRANSPORT) {
      await this.auditLogService.log({
        entityType: 'EmailMessage',
        entityId: emailForValidation.id,
        action: 'EMAIL_PARKED_DEPARTMENT_INACTIVE',
        detailsJson: { department: mailboxDepartment },
      });
      await this.prismaService.emailMessage.update({
        where: { id: emailForValidation.id },
        data: { status: EmailStatus.PROCESSED },
      });
      this.logger.log(
        `Email parked (department ${mailboxDepartment} not handled by this pipeline) emailMessageId=${emailForValidation.id}`,
      );
      return;
    }

    await this.prismaService.emailMessage.update({
      where: { id: emailForValidation.id },
      data: { status: EmailStatus.PROCESSING },
    });

    const combinedText = this.buildCombinedText({
      subject: emailForValidation.subject,
      bodyText: emailForValidation.bodyText,
      bodyHtml: emailForValidation.bodyHtml,
      attachments: emailForValidation.attachments.map((a: any) => ({
        fileName: a.fileName,
        extractedText: a.extractedText,
      })),
    });

    let order: TransportOrder;
    try {
      const linkMatch =
        await this.threadLinkingService.findExistingOrderForIncomingEmail({
          emailMessageId: emailForValidation.id,
          context: this.emailContextMapperService.toIncomingEmailContext(
            emailForValidation as any,
          ),
          combinedText,
        });

      if (linkMatch?.orderId) {
        const existingOrder =
          await this.prismaService.transportOrder.findUnique({
            where: { id: linkMatch.orderId },
            include: {
              emailMessage: { include: { attachments: true } },
              fields: true,
              missingFields: true,
            },
          });

        if (existingOrder) {
          // Customer reply: new flow sends the reply's .eml to the AI and
          // merges what it returns into the existing order (non-destructive).
          if (this.aiEmailAnalysisEnabled()) {
            await this.processReplyViaAiAnalysis({
              replyEmailMessage: emailForValidation,
              existingOrder,
              linkMatchType: linkMatch.type,
            });
          } else {
            await this.processCustomerReply({
              replyEmailMessage: emailForValidation,
              existingOrder,
              linkMatchType: linkMatch.type,
            });
          }
          return;
        }
      }

      // NEW FLOW: the AI classifies/extracts from the raw .eml and returns the
      // order(s). We only store. The legacy pipeline below stays for the future,
      // behind the flag.
      if (this.aiEmailAnalysisEnabled()) {
        await this.processViaAiAnalysis(emailForValidation);
        return;
      }

      const attachmentsText = (emailForValidation.attachments || [])
        .map((a: any) => (a.extractedText || '').toString().trim())
        .filter((x: string) => x.length > 0)
        .join('\n\n');

      // Language detected by the AI classifier (more reliable than the keyword
      // heuristic); used for the extraction payload below.
      let classifiedLanguage: string | null = null;

      // AI classification gate (new, non-reply emails only). Replies are handled
      // above and never reach this point. Safety net: if the classifier is
      // disabled/unavailable/undecided it returns null and we proceed as before,
      // so a real email is never dropped because of the classifier.
      // Skip entirely when the email is already confirmed as a transport order
      // (manual "process anyway" override or a prior positive classification).
      if (emailForValidation.isTransportOrder !== true) {
      try {
        const aiClassification = await this.aiClassificationService.classify({
          emailId: emailForValidation.id,
          mailboxId: emailForValidation.mailboxId,
          department: emailForValidation.mailbox?.department ?? null,
          from: emailForValidation.fromEmail ?? null,
          subject: emailForValidation.subject ?? null,
          bodyText: emailForValidation.bodyText ?? null,
          attachmentsText: attachmentsText || null,
          combinedText,
        });

        if (aiClassification) {
          classifiedLanguage = aiClassification.language ?? null;
          await this.prismaService.emailMessage.update({
            where: { id: emailForValidation.id },
            data: {
              isTransportOrder: aiClassification.isTransportOrder,
              classificationReason: aiClassification.reason,
              classificationLanguage: aiClassification.language,
              classifiedAt: new Date(),
            },
          });

          await this.auditLogService.log({
            entityType: 'EmailMessage',
            entityId: emailForValidation.id,
            action: 'AI_CLASSIFICATION_COMPLETED',
            detailsJson: {
              isTransportOrder: aiClassification.isTransportOrder,
              reason: aiClassification.reason,
              language: aiClassification.language,
              priority: aiClassification.priority,
            },
          });

          if (aiClassification.isTransportOrder === false) {
            await this.auditLogService.log({
              entityType: 'EmailMessage',
              entityId: emailForValidation.id,
              action: 'EMAIL_IGNORED_NOT_TRANSPORT',
              detailsJson: { reason: aiClassification.reason },
            });
            await this.prismaService.emailMessage.update({
              where: { id: emailForValidation.id },
              data: { status: EmailStatus.PROCESSED },
            });
            this.logger.log(
              `Email ignored (not a transport order) emailMessageId=${emailForValidation.id}`,
            );
            return;
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `AI classification gate skipped for emailMessageId=${emailForValidation.id}: ${err?.message ?? err}`,
        );
      }
      }

      const classification = this.orderClassifierService.classify(
        {
          subject: emailForValidation.subject,
          bodyText: emailForValidation.bodyText,
          bodyHtml: emailForValidation.bodyHtml,
        },
        attachmentsText,
      );

      // Batch detection: a single email/attachment can hold many orders
      // (e.g. a weekly Dispo). Rules-first per client, then our own AI fallback.
      const splitText = [
        emailForValidation.subject,
        emailForValidation.bodyText,
        attachmentsText,
      ]
        .filter(Boolean)
        .join('\n');
      const split = await this.orderSplitService.split({
        fromEmail: emailForValidation.fromEmail,
        bodyText: emailForValidation.bodyText,
        combinedText: splitText,
      });
      if (split.isBatch) {
        await this.handleBatch(emailForValidation, classification, split);
        return;
      }

      // emailMessageId is no longer unique (one email can yield several batch
      // orders), so find-or-create the single primary order (batchImportId null)
      // instead of upserting on emailMessageId.
      const existingPrimaryOrder =
        await this.prismaService.transportOrder.findFirst({
          where: {
            emailMessageId: emailForValidation.id,
            batchImportId: null,
          },
        });
      order = existingPrimaryOrder
        ? await this.prismaService.transportOrder.update({
            where: { id: existingPrimaryOrder.id },
            data: {
              department: emailForValidation.mailbox.department,
              customerEmail: emailForValidation.fromEmail,
              customerName: emailForValidation.fromName || null,
              status: OrderStatus.PROCESSING,
              type: classification.type,
              originalOrderReference:
                classification.originalOrderReference ?? undefined,
            },
          })
        : await this.prismaService.transportOrder.create({
            data: {
              emailMessageId: emailForValidation.id,
              department: emailForValidation.mailbox.department,
              type: classification.type,
              status: OrderStatus.PROCESSING,
              customerEmail: emailForValidation.fromEmail,
              customerName: emailForValidation.fromName || null,
              originalOrderReference:
                classification.originalOrderReference ?? null,
            },
          });

      if (classification.type === OrderType.MODIFICATION) {
        await this.prismaService.transportOrder.update({
          where: { id: order.id },
          data: {
            type: OrderType.MODIFICATION,
            status: OrderStatus.MANUAL_REVIEW,
            originalOrderReference:
              classification.originalOrderReference ??
              order.originalOrderReference ??
              null,
          },
        });

        await this.auditLogService.log({
          entityType: 'TransportOrder',
          entityId: order.id,
          action: 'MODIFICATION_DETECTED',
          detailsJson: {
            emailMessageId: emailForValidation.id,
            providerMessageId: emailForValidation.graphMessageId,
            confidence: classification.confidence,
            reason: classification.reason,
            originalOrderReference:
              classification.originalOrderReference ?? null,
          },
        });

        await this.prismaService.emailMessage.update({
          where: { id: emailForValidation.id },
          data: { status: EmailStatus.PROCESSED },
        });

        this.logger.log(
          `Modification detected for emailMessageId=${emailForValidation.id}`,
        );
        return;
      }

      // NEW_ORDER flow
      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: {
          type:
            classification.type === OrderType.UNKNOWN
              ? OrderType.UNKNOWN
              : OrderType.NEW_ORDER,
          status: OrderStatus.PROCESSING,
        },
      });

      const deterministic =
        await this.requiredFieldsService.validateEmailContent(
          emailForValidation,
          combinedText,
          { enqueueJobs: false },
        );

      // Per-client knowledge base: resolve (sender, forwarded sender, or content
      // markers) and derive this client's deterministic fields for the order.
      const clientProfile = this.clientProfileService.resolve({
        fromEmail: emailForValidation.fromEmail,
        bodyText: emailForValidation.bodyText,
        text: combinedText,
      });
      const profileFields = clientProfile
        ? this.clientProfileService.derive(clientProfile, combinedText)
        : {};
      const zipcodeHints = await this.resolveZipcodeEnrichment({
        combinedText,
        emailSubject: emailForValidation.subject ?? '',
        fieldValues: profileFields,
        detectedFields: deterministic.detectedFields,
      });
      const supplementalFields = this.mergeMissingFieldValues(
        profileFields,
        zipcodeHints,
      ) as Record<string, string>;
      const baseValidation =
        Object.keys(supplementalFields).length > 0
          ? await this.transportBookingValidationService.validateOrderFromFieldValues(
              {
                orderId: order.id,
                emailMessageId: emailForValidation.id,
                emailSubject: emailForValidation.subject ?? '',
                fieldValues: this.mergeMissingFieldValues(
                  supplementalFields,
                  deterministic.detectedFields,
                ),
                source: 'email',
                fieldMetaByKey: this.buildProfileFieldMeta(
                  profileFields,
                  supplementalFields,
                ),
              },
              { enqueueJobs: false },
            )
          : deterministic;

      const aiDecisionMetrics = this.buildAiDecisionMetrics({
        requiredMissingCount: baseValidation.missingFields.length,
        recommendedMissingCount:
          baseValidation.validationWarnings?.length ?? 0,
        detectedFieldCount: baseValidation.detectedFields.filter(
          (field) => field?.key && !this.aiExcludeKeys.has(field.key),
        ).length,
        overallConfidence: baseValidation.overallConfidence,
      });
      const shouldAi = this.shouldUseAiExtraction(aiDecisionMetrics);

      if (shouldAi) {
        await this.auditLogService.log({
          entityType: 'TransportOrder',
          entityId: order.id,
          action: 'AI_AUTO_PROCESSING_TRIGGERED',
          detailsJson: {
            context: 'new_order',
            emailMessageId: emailForValidation.id,
            ...aiDecisionMetrics,
          },
        });

        const aiPayload = {
          orderId: order.id,
          customerEmail: order.customerEmail ?? null,
          subject: emailForValidation.subject ?? null,
          bodyText: emailForValidation.bodyText ?? null,
          attachmentsText: attachmentsText || null,
          combinedText,
          requiredFields: TRANSPORT_BOOKING_FIELD_RULES,
          detectedFields: this.mergeDetectedFields(
            baseValidation.detectedFields.filter(
              (f) => f?.key && !this.aiExcludeKeys.has(f.key),
            ),
            [
              ...this.toProfileDetectedFields(profileFields),
              ...zipcodeHints,
            ],
          ),
          missingFields: baseValidation.missingFields,
          department: order.department ?? null,
          language:
            [
              classifiedLanguage,
              (emailForValidation as any).classificationLanguage,
            ].find((l): l is string => Boolean(l) && l !== 'unknown') ||
            this.detectLanguage(combinedText),
          emailMetadata: {
            fromEmail: emailForValidation.fromEmail ?? null,
            fromName: emailForValidation.fromName ?? null,
            receivedAt: emailForValidation.receivedAt ?? null,
          },
          // Raw original email (.eml). The new flow sends only this to the AI.
          email: (emailForValidation as any).rawMimeBase64 ?? null,
          // Per-client knowledge base (resolved above). Null for unmapped
          // clients. Lets the AI route honor fixed data / patterns / value maps.
          clientProfile: clientProfile
            ? this.clientProfileService.payloadSummary(clientProfile)
            : null,
        };
        const aiResult = await this.aiExtractionService.extract(aiPayload);
        await this.recordAiExtractionRequest({
          orderId: order.id,
          payload: aiPayload,
          aiResult,
        });

        if (aiResult?.fields) {
          const mergedFields = { ...aiResult.fields } as Record<
            string,
            unknown
          >;
          for (const d of baseValidation.detectedFields) {
            if (!d?.key) continue;
            if (mergedFields[d.key] != null) continue;
            if (!d.value) continue;
            mergedFields[d.key] = d.value;
          }
          // Client-profile deterministic fields are authoritative over the AI.
          Object.assign(mergedFields, supplementalFields);

          // Route "deliver/load until X" times to the *_time_till slot.
          const routedFields = routeTimeBounds(mergedFields, combinedText);

          await this.transportBookingValidationService.validateOrderFromFieldValues(
            {
              orderId: order.id,
              emailMessageId: emailForValidation.id,
              emailSubject: emailForValidation.subject ?? '',
              fieldValues: routedFields,
              source: 'ai',
              fieldMetaByKey: this.buildProfileFieldMeta(
                supplementalFields,
                routedFields,
              ),
            },
            { enqueueJobs: true },
          );
        } else {
          await this.auditLogService.log({
            entityType: 'TransportOrder',
            entityId: order.id,
            action: 'AI_AUTO_PROCESSING_SKIPPED',
            detailsJson: {
              context: 'new_order',
              emailMessageId: emailForValidation.id,
              reason: 'AI was requested by heuristics but returned no usable fields.',
              ...aiDecisionMetrics,
            },
          });

          const applied = await this.applyProfileFields({
            orderId: order.id,
            emailMessageId: emailForValidation.id,
            emailSubject: emailForValidation.subject ?? '',
            detectedFields: baseValidation.detectedFields,
            profileFields: supplementalFields,
            combinedText,
          });
          if (!applied) {
            await this.transportBookingValidationService.enqueueJobsForOrder({
              orderId: order.id,
              emailMessageId: emailForValidation.id,
            });
          }
        }
      } else {
        await this.auditLogService.log({
          entityType: 'TransportOrder',
          entityId: order.id,
          action: 'AI_AUTO_PROCESSING_SKIPPED',
          detailsJson: {
            context: 'new_order',
            emailMessageId: emailForValidation.id,
            reason: 'Deterministic validation considered sufficient.',
            ...aiDecisionMetrics,
          },
        });

        const applied = await this.applyProfileFields({
          orderId: order.id,
          emailMessageId: emailForValidation.id,
          emailSubject: emailForValidation.subject ?? '',
          detectedFields: baseValidation.detectedFields,
          profileFields: supplementalFields,
          combinedText,
        });
        if (!applied) {
          await this.transportBookingValidationService.enqueueJobsForOrder({
            orderId: order.id,
            emailMessageId: emailForValidation.id,
          });
        }
      }

      await this.prismaService.emailMessage.update({
        where: { id: emailForValidation.id },
        data: { status: EmailStatus.PROCESSED },
      });

      this.logger.log(
        `Processed emailMessageId=${emailForValidation.id} orderId=${order.id}`,
      );
    } catch (err: any) {
      await this.prismaService.emailMessage.update({
        where: { id: emailForValidation.id },
        data: { status: EmailStatus.FAILED },
      });

      this.logger.error(
        `Failed processing emailMessageId=${emailForValidation.id}: ${err?.message ?? err}`,
        err?.stack,
      );

      throw err;
    }
  }
}
