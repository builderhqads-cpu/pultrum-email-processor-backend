import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import { AttachmentParserService } from '../attachment-parser/attachment-parser.service';
import { AiExtractionService } from '../ai-extraction/ai-extraction.service';
import { FieldMergeService } from '../field-merge/field-merge.service';
import { LabelParserService } from '../label-parser/label-parser.service';
import { RegexExtractionService } from '../regex-extraction/regex-extraction.service';
import { TransportBookingValidationService } from '../transport-booking-validation/transport-booking-validation.service';
import { TRANSPORT_BOOKING_FIELD_RULES } from '../required-fields/transport-booking-field-rules';

const normalizeWhitespace = (value: string) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();

@Injectable()
export class ExtractionPipelineService {
  private readonly logger = new Logger(ExtractionPipelineService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly attachmentParserService: AttachmentParserService,
    private readonly labelParserService: LabelParserService,
    private readonly regexExtractionService: RegexExtractionService,
    private readonly aiExtractionService: AiExtractionService,
    private readonly fieldMergeService: FieldMergeService,
    private readonly transportBookingValidationService: TransportBookingValidationService,
  ) {}

  private isTechnicalField(key: string) {
    const rule = TRANSPORT_BOOKING_FIELD_RULES.find((r) => r.key === key);
    return Boolean(rule?.generated);
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

    // Requirement: bodyHtml sanitized
    const htmlSanitized = input.bodyHtml
      ? sanitizeExtractedValue(input.bodyHtml)
      : '';
    if (htmlSanitized) parts.push(`BodyHtml:\n${htmlSanitized}`);

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

    if (attachmentParts.length) parts.push(attachmentParts.join('\n\n'));

    return parts.join('\n\n');
  }

  async runForOrder(orderId: string, opts?: { forceAiExtraction?: boolean }) {
    // 1) Fetch Order + Email + Attachments
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: {
          include: {
            attachments: {
              select: {
                id: true,
                fileName: true,
                extractedText: true,
              },
            },
          },
        },
      },
    });

    if (!order) throw new Error(`TransportOrder not found: id=${orderId}`);
    if (!order.emailMessage) {
      throw new Error(
        `EmailMessage not found for orderId=${orderId} emailMessageId=${order.emailMessageId}`,
      );
    }

    // 5) Run AttachmentExtractionService (via AttachmentParserService) - best effort
    const attachments = (order.emailMessage.attachments ?? []) as Array<{
      id: string;
      fileName: string;
      extractedText: string | null;
    }>;
    for (const att of attachments) {
      try {
        if (att.extractedText && att.extractedText.trim()) continue;
        await this.attachmentParserService.extractTextFromAttachment(att.id);
      } catch (err: any) {
        this.logger.warn(
          `Attachment extraction failed orderId=${orderId} attachmentId=${att.id} fileName=${att.fileName}: ${err?.message ?? err}`,
        );
      }
    }

    // Refresh attachment extractedText after extraction attempts
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id: order.emailMessageId },
      select: {
        id: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
        attachments: { select: { fileName: true, extractedText: true } },
      },
    });
    if (!email) throw new Error(`EmailMessage not found: id=${order.emailMessageId}`);

    // 2) combinedText
    const combinedText = this.buildCombinedText({
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      attachments: (email.attachments ?? []).map((a: any) => ({
        fileName: a.fileName,
        extractedText: a.extractedText ?? null,
      })),
    });

    // 3) LabelParserService
    const labelFields = this.labelParserService.extract(combinedText);

    // 4) RegexExtractionService (do not override higher confidence EMAIL fields)
    const regexFields = this.regexExtractionService.extract(
      combinedText,
      labelFields.map((f) => ({
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        source: f.source,
      })),
    );

    // 6) FieldMergeService
    const mergedFields = this.fieldMergeService.merge([
      ...labelFields.map((f) => ({
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        source: f.source,
      })),
      ...regexFields.map((f) => ({
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        source: f.source,
      })),
    ]);

    // 7) extractionConfidence (simple average of merged confidences)
    const extractionConfidence =
      mergedFields.length > 0
        ? mergedFields.reduce((acc, f) => acc + (f.confidence ?? 0), 0) /
          mergedFields.length
        : 0;

    // Convert to plain fieldValues for validation
    const fieldValues: Record<string, string> = {};
    for (const f of mergedFields) {
      if (!f.key) continue;
      const value = sanitizeExtractedValue(f.value ?? '');
      if (!value) continue;
      fieldValues[f.key] = normalizeWhitespace(value);
    }

    // 8) Validate (no AI jobs here)
    const validation =
      await this.transportBookingValidationService.validateOrderFromFieldValues(
        {
          orderId: order.id,
          emailMessageId: order.emailMessageId,
          emailSubject: email.subject ?? '',
          fieldValues,
          source: 'email',
        },
        { enqueueJobs: false },
      );

    const deterministicFailed = mergedFields.length === 0 && !validation.isComplete;
    const shouldCallAi =
      opts?.forceAiExtraction === true ||
      (!validation.isComplete &&
        (extractionConfidence < 0.75 ||
          (validation.missingFields?.length ?? 0) > 5 ||
          deterministicFailed));

    let finalValidation = validation;
    let aiUsed = false;

    if (shouldCallAi) {
      this.logger.log(
        `AI extraction conditions met orderId=${order.id} extractionConfidence=${extractionConfidence.toFixed(3)} missingFields=${validation.missingFields.length} deterministicFailed=${deterministicFailed}`,
      );

      const attachmentsTextOnly =
        (email.attachments ?? [])
          .map((a: any) => (a.extractedText || '').toString().trim())
          .filter(Boolean)
          .join('\n\n') || null;

      this.logger.log(
        `AI extraction payload summary orderId=${order.id} attachmentsCount=${(email.attachments ?? []).length} attachmentsTextChars=${attachmentsTextOnly?.length ?? 0} combinedTextChars=${combinedText.length}`,
      );

      const aiRes = await this.aiExtractionService.extract({
        orderId: order.id,
        customerEmail: order.customerEmail ?? null,
        subject: email.subject ?? null,
        bodyText: email.bodyText ?? null,
        attachmentsText: attachmentsTextOnly,
        combinedText,
        department: order.department ?? null,
        requiredFields: TRANSPORT_BOOKING_FIELD_RULES,
        // Do not send technical/system-generated fields to the AI extraction endpoint.
        detectedFields: mergedFields
          .filter((f) => !this.isTechnicalField(f.key))
          .map((f) => ({
            key: f.key,
            label: f.key,
            value: f.value ?? '',
            confidence: f.confidence ?? 0,
          })),
        missingFields: validation.missingFields,
        language: null,
      });

      if (aiRes?.fields && Object.keys(aiRes.fields).length) {
        aiUsed = true;
        this.logger.log(
          `AI extraction returned fields orderId=${order.id} keys=${Object.keys(aiRes.fields).join(',')}`,
        );

        const aiFields = Object.entries(aiRes.fields).map(([key, value]) => ({
          key,
          value,
          confidence: 0.8,
          source: 'AI' as const,
        }));

        const mergedWithAi = this.fieldMergeService.merge([
          ...mergedFields.map((f) => ({
            key: f.key,
            value: f.value,
            confidence: f.confidence,
            source: f.source,
          })),
          ...aiFields,
        ]);

        const fieldValuesWithAi: Record<string, string> = {};
        for (const f of mergedWithAi) {
          const v = sanitizeExtractedValue(f.value ?? '');
          if (!v) continue;
          fieldValuesWithAi[f.key] = normalizeWhitespace(v);
        }

        finalValidation =
          await this.transportBookingValidationService.validateOrderFromFieldValues(
            {
              orderId: order.id,
              emailMessageId: order.emailMessageId,
              emailSubject: email.subject ?? '',
              fieldValues: fieldValuesWithAi,
              source: 'ai',
            },
            { enqueueJobs: false },
          );
      } else {
        this.logger.warn(`AI extraction returned no fields orderId=${order.id}`);
      }
    }

    // Requirement: READY_TO_XML vs MISSING_INFORMATION
    const nextStatus = finalValidation.isComplete
      ? OrderStatus.READY_TO_XML
      : OrderStatus.MISSING_INFORMATION;

    await this.prismaService.transportOrder.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        overallConfidence: finalValidation.overallConfidence,
      },
    });

    return {
      orderId: order.id,
      combinedText,
      detectedFields: [...labelFields, ...regexFields],
      mergedFields,
      extractionConfidence,
      validation: finalValidation,
      aiUsed,
    };
  }
}
