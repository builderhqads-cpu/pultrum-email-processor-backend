import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  AttachmentExtractionStatus,
  Department,
  EmailLinkMethod,
  EmailStatus,
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
import { sanitizeExtractedValue } from '../../utils/sanitize';
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
  ) {
    super();
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
      { confidence?: number | null; source?: MergeableField['source'] }
    > = {};

    for (const field of merged) {
      const value = sanitizeExtractedValue(field.value ?? '');
      if (!field.key || !value) continue;
      fieldValues[field.key] = value;
      fieldMetaByKey[field.key] = {
        confidence: field.confidence,
        source: field.source,
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

    const mergedDeterministic = this.buildFieldPayload([
      ...this.toMergeableFieldsFromOrder(existingOrder),
      ...this.toMergeableFieldsFromDetected(
        deterministic.detectedFields,
        'EMAIL',
      ),
    ]);

    const aiDecisionMetrics = this.buildAiDecisionMetrics({
      requiredMissingCount: deterministic.missingFields.length,
      recommendedMissingCount:
        deterministic.validationWarnings?.length ?? 0,
      detectedFieldCount: deterministic.detectedFields.filter(
        (field) => field?.key && !this.aiExcludeKeys.has(field.key),
      ).length,
      overallConfidence: deterministic.overallConfidence,
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
              deterministic.detectedFields.find(
                (item) => item.key === field.key,
              )?.label ?? field.key,
            value: field.value ?? '',
            confidence: field.confidence ?? 0,
          })),
        missingFields: deterministic.missingFields,
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
          await this.processCustomerReply({
            replyEmailMessage: emailForValidation,
            existingOrder,
            linkMatchType: linkMatch.type,
          });
          return;
        }
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

      order = await this.prismaService.transportOrder.upsert({
        where: { emailMessageId: emailForValidation.id },
        create: {
          emailMessageId: emailForValidation.id,
          department: emailForValidation.mailbox.department,
          type: classification.type,
          status: OrderStatus.PROCESSING,
          customerEmail: emailForValidation.fromEmail,
          customerName: emailForValidation.fromName || null,
          originalOrderReference: classification.originalOrderReference ?? null,
        },
        update: {
          department: emailForValidation.mailbox.department,
          customerEmail: emailForValidation.fromEmail,
          customerName: emailForValidation.fromName || null,
          status: OrderStatus.PROCESSING,
          type: classification.type,
          originalOrderReference:
            classification.originalOrderReference ?? undefined,
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

      const aiDecisionMetrics = this.buildAiDecisionMetrics({
        requiredMissingCount: deterministic.missingFields.length,
        recommendedMissingCount:
          deterministic.validationWarnings?.length ?? 0,
        detectedFieldCount: deterministic.detectedFields.filter(
          (field) => field?.key && !this.aiExcludeKeys.has(field.key),
        ).length,
        overallConfidence: deterministic.overallConfidence,
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
          detectedFields: deterministic.detectedFields.filter(
            (f) => f?.key && !this.aiExcludeKeys.has(f.key),
          ),
          missingFields: deterministic.missingFields,
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
          for (const d of deterministic.detectedFields) {
            if (!d?.key) continue;
            if (mergedFields[d.key] != null) continue;
            if (!d.value) continue;
            mergedFields[d.key] = d.value;
          }

          await this.transportBookingValidationService.validateOrderFromFieldValues(
            {
              orderId: order.id,
              emailMessageId: emailForValidation.id,
              emailSubject: emailForValidation.subject ?? '',
              fieldValues: mergedFields,
              source: 'ai',
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

          await this.transportBookingValidationService.enqueueJobsForOrder({
            orderId: order.id,
            emailMessageId: emailForValidation.id,
          });
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

        await this.transportBookingValidationService.enqueueJobsForOrder({
          orderId: order.id,
          emailMessageId: emailForValidation.id,
        });
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
