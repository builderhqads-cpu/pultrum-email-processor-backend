import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransportBookingFieldRule } from '../required-fields/transport-booking-field-rules';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  AttachmentExtractionStatus,
  FieldRequirement,
  OrderFieldSource,
} from '@prisma/client';
import {
  getRuleRequirement,
  TRANSPORT_BOOKING_FIELD_RULES,
} from '../required-fields/transport-booking-field-rules';
import { AddressEnrichmentService } from '../geocoding/address-enrichment.service';

export type AiExtractionPayload = {
  orderId: string;
  customerEmail?: string | null;
  subject: string | null;
  bodyText: string | null;
  attachmentsText: string | null;
  combinedText: string;
  requiredFields: Array<
    TransportBookingFieldRule & {
      required?: boolean;
    }
  >;
  detectedFields: Array<{
    key: string;
    label: string;
    value: string;
    confidence: number;
  }>;
  missingFields: Array<{
    key: string;
    label: string;
    reason: string;
  }>;
  department: string | null;
  language: string | null;
  emailMetadata?: Record<string, any>;
  /** Raw original email (.eml, base64) — the ONLY content sent in the new flow. */
  email?: string | null;
};

export type AiPreDetectedField = {
  key: string;
  label: string;
  value: string;
  confidence: number;
};

/**
 * Customer context forwarded to the extraction route. `instructions` is the
 * operator's free-text guidance on how THIS customer builds their documents
 * (where each value lives, layout conventions, per-field rules) — e.g.
 * "Laadreferentie: 10-cijferig nummer dat TR bevat".
 * It is guidance for the extraction, never a value.
 */
export type AiCustomerProfileContext = {
  name: string;
  instructions: string;
};

/** One order returned by the AI in the new "send-the-eml" flow. */
export type AiOrderResult = {
  externalReference?: string | null;
  fields: Record<string, string>;
};

/** The AI's analysis of a whole email (classification + the orders it found). */
export type AiEmailAnalysis = {
  isTransportOrder: boolean;
  confidence: number;
  reason: string;
  language: string | null;
  orders: AiOrderResult[];
  /** The full raw response from the route (for the AI requests panel). */
  rawResponse?: any;
  /** The exact body we POSTed (eml truncated), for the AI requests panel. */
  requestPreview?: any;
};

export type AiExtractionResult = {
  fields: Record<string, string>;
  detectedFields?: Array<{
    key: string;
    label: string;
    value: string;
    confidence: number;
  }>;
  missingFields?: Array<{
    key: string;
    label: string;
    reason: string;
  }>;
  rawResponse: any;
};

@Injectable()
export class AiExtractionService {
  private readonly logger = new Logger(AiExtractionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly addressEnrichmentService: AddressEnrichmentService,
  ) {}

  private mergeDetectedFields(
    base: AiExtractionPayload['detectedFields'],
    additions: AiPreDetectedField[],
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

  private buildCombinedText(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    attachments?: Array<{ fileName: string; extractedText: string | null }>;
  }) {
    const parts: string[] = [];
    if (input.subject) parts.push(`Subject:\n${input.subject}`);
    if (input.bodyText) parts.push(`BodyText:\n${input.bodyText}`);

    const htmlSanitized = input.bodyHtml
      ? sanitizeExtractedValue(input.bodyHtml)
      : '';
    if (htmlSanitized) parts.push(`BodyHtml:\n${htmlSanitized}`);

    const attachmentParts =
      input.attachments
        ?.map((a) => {
          const lines: string[] = [];
          if (a.fileName) lines.push(`AttachmentFileName: ${a.fileName}`);
          if (a.extractedText)
            lines.push(`AttachmentExtractedText:\n${a.extractedText}`);
          return lines.join('\n');
        })
        .filter((x) => x.trim().length > 0) ?? [];

    if (attachmentParts.length) parts.push(attachmentParts.join('\n\n'));
    return parts.join('\n\n');
  }

  private maybeFixMojibake(input: string | null | undefined) {
    const value = (input ?? '').toString();
    if (!value) return value;

    // Heuristic: "Ã" sequences usually indicate UTF-8 bytes decoded as latin1.
    if (!/[ÃÂ]/.test(value)) return value;
    try {
      const fixed = Buffer.from(value, 'latin1').toString('utf8');
      // Prefer the fixed version only if it reduces mojibake markers.
      const score = (s: string) => (s.match(/[ÃÂ]/g) || []).length;
      return score(fixed) < score(value) ? fixed : value;
    } catch {
      return value;
    }
  }

  private decodeXmlEntities(input: string) {
    // Minimal XML entity decoding for text nodes.
    return (input || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private tryParseFieldsFromXmlText(
    text: string,
  ): Record<string, string> | null {
    const raw = (text || '').toString();
    if (!raw) return null;
    if (!/<field\b/i.test(raw)) return null;

    const map: Record<string, string> = {};
    const re = /<field\b[^>]*\bkey="([^"]+)"[^>]*>([\s\S]*?)<\/field>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      const key = (match[1] || '').trim();
      if (!key) continue;
      // Strip any tags inside the field node (should be plain text, but be defensive).
      const inner = (match[2] || '').replace(/<[^>]+>/g, '');
      const decoded = this.decodeXmlEntities(inner);
      const value = sanitizeExtractedValue(decoded);
      if (!value) continue;
      map[key] = value;
    }
    return Object.keys(map).length ? map : null;
  }

  private resolveApiUrl() {
    const rawBase = (
      this.configService.get<string>('AI_API_BASE_URL') || ''
    ).trim();
    if (!rawBase) return '';

    const rawPath =
      (this.configService.get<string>('AI_EXTRACTION_API_URL') || '').trim() ||
      '/extract-transport-order';

    const normalizeBase = (b: string) => b.replace(/\/+$/, '');
    const normalizePath = (p: string) => (p.startsWith('/') ? p : `/${p}`);
    return `${normalizeBase(rawBase)}${normalizePath(rawPath)}`;
  }

  /** URL for the new "send-the-eml" route (default /eml-process). */
  private resolveEmlProcessUrl() {
    const rawBase = (
      this.configService.get<string>('AI_API_BASE_URL') || ''
    ).trim();
    if (!rawBase) return '';

    const rawPath =
      (this.configService.get<string>('AI_EML_PROCESS_API_URL') || '').trim() ||
      '/eml-process';

    const normalizeBase = (b: string) => b.replace(/\/+$/, '');
    const normalizePath = (p: string) => (p.startsWith('/') ? p : `/${p}`);
    return `${normalizeBase(rawBase)}${normalizePath(rawPath)}`;
  }

  private getApiKey() {
    return (this.configService.get<string>('AI_API_KEY') || '').trim();
  }

  private normalizeFieldMap(input: any): Record<string, string> {
    const fields: Record<string, string> = {};
    if (!input || typeof input !== 'object') return fields;

    for (const [k, v] of Object.entries(input)) {
      const key = (k ?? '').toString().trim();
      if (!key) continue;
      const value = sanitizeExtractedValue(v == null ? '' : String(v));
      if (!value) continue;
      fields[key] = value;
    }
    return fields;
  }

  private tryParseJson(input: string) {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }

  private parseFunctionArguments(
    input: unknown,
  ): Record<string, string> | null {
    if (!input) return null;

    const payload =
      typeof input === 'string' ? this.tryParseJson(input.trim()) : input;

    if (!payload || typeof payload !== 'object') return null;

    const direct = this.parseFieldsFromResponse(payload);
    if (direct) return direct;

    const record = payload as Record<string, unknown>;

    if (record.arguments) {
      return this.parseFunctionArguments(record.arguments);
    }

    return null;
  }

  private parseToolCalls(input: unknown): Record<string, string> | null {
    if (!Array.isArray(input)) return null;

    for (const toolCall of input) {
      if (!toolCall || typeof toolCall !== 'object') continue;

      const record = toolCall as Record<string, unknown>;
      const fromFunction = this.parseFunctionArguments(record.function);
      if (fromFunction) return fromFunction;

      const directArgs = this.parseFunctionArguments(record.arguments);
      if (directArgs) return directArgs;
    }

    return null;
  }

  private normalizeDetectedFields(input: unknown) {
    if (!Array.isArray(input)) return [];

    return input
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const key = sanitizeExtractedValue((item as any).key ?? '');
        const label = sanitizeExtractedValue((item as any).label ?? key);
        const value = sanitizeExtractedValue((item as any).value ?? '');
        const confidenceRaw = (item as any).confidence;
        const confidence =
          typeof confidenceRaw === 'number'
            ? confidenceRaw
            : Number(confidenceRaw);

        if (!key || !label || !value) return null;

        return {
          key,
          label,
          value,
          confidence: Number.isFinite(confidence) ? confidence : 0.85,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  private normalizeMissingFields(input: unknown) {
    if (!Array.isArray(input)) return [];

    return input
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const key = sanitizeExtractedValue((item as any).key ?? '');
        const label = sanitizeExtractedValue((item as any).label ?? key);
        const reason =
          sanitizeExtractedValue((item as any).reason ?? '') ||
          'Not detected in email content';

        if (!key || !label) return null;

        return { key, label, reason };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  private parseDetectedFieldsFromResponse(json: any) {
    if (!json) return [];

    if (typeof json === 'string') {
      const parsedJson = this.tryParseJson(json.trim());
      return parsedJson ? this.parseDetectedFieldsFromResponse(parsedJson) : [];
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).detectedFields)
    ) {
      return this.normalizeDetectedFields((json as any).detectedFields);
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).fields)
    ) {
      const detected = this.normalizeDetectedFields((json as any).fields);
      if (detected.length) return detected;
    }

    if (
      json &&
      typeof json === 'object' &&
      typeof (json as any).fields === 'object'
    ) {
      const map = this.normalizeFieldMap((json as any).fields);
      if (Object.keys(map).length) {
        return Object.entries(map).map(([key, value]) => ({
          key,
          label: key,
          value,
          confidence: 0.85,
        }));
      }
    }

    const nestedCandidates = [
      (json as any)?.data,
      (json as any)?.message,
      (json as any)?.function_call,
      (json as any)?.arguments,
    ];

    for (const candidate of nestedCandidates) {
      const parsed = this.parseDetectedFieldsFromResponse(candidate);
      if (parsed.length) return parsed;
    }

    if (Array.isArray((json as any)?.choices)) {
      for (const candidate of (json as any).choices) {
        const parsed = this.parseDetectedFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    if (Array.isArray((json as any)?.output)) {
      for (const candidate of (json as any).output) {
        const parsed = this.parseDetectedFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    if (Array.isArray((json as any)?.tool_calls)) {
      for (const candidate of (json as any).tool_calls) {
        const parsed = this.parseDetectedFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    return [];
  }

  private parseMissingFieldsFromResponse(json: any) {
    if (!json) return [];

    if (typeof json === 'string') {
      const parsedJson = this.tryParseJson(json.trim());
      return parsedJson ? this.parseMissingFieldsFromResponse(parsedJson) : [];
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).missingFields)
    ) {
      return this.normalizeMissingFields((json as any).missingFields);
    }

    const nestedCandidates = [
      (json as any)?.data,
      (json as any)?.message,
      (json as any)?.function_call,
      (json as any)?.arguments,
    ];

    for (const candidate of nestedCandidates) {
      const parsed = this.parseMissingFieldsFromResponse(candidate);
      if (parsed.length) return parsed;
    }

    if (Array.isArray((json as any)?.choices)) {
      for (const candidate of (json as any).choices) {
        const parsed = this.parseMissingFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    if (Array.isArray((json as any)?.output)) {
      for (const candidate of (json as any).output) {
        const parsed = this.parseMissingFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    if (Array.isArray((json as any)?.tool_calls)) {
      for (const candidate of (json as any).tool_calls) {
        const parsed = this.parseMissingFieldsFromResponse(candidate);
        if (parsed.length) return parsed;
      }
    }

    return [];
  }

  private parseFieldsFromResponse(json: any): Record<string, string> | null {
    if (!json) return null;

    if (typeof json === 'string') {
      const parsedJson = this.tryParseJson(json.trim());
      if (parsedJson) return this.parseFieldsFromResponse(parsedJson);

      return this.tryParseFieldsFromXmlText(json);
    }

    // Common gateway shape: { model, prompt, output: "<xml...>", usage }
    if (
      json &&
      typeof json === 'object' &&
      typeof (json as any).output === 'string'
    ) {
      const parsed = this.tryParseFieldsFromXmlText((json as any).output);
      if (parsed) return parsed;
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).output)
    ) {
      for (const item of (json as any).output) {
        const parsed =
          this.parseFieldsFromResponse(item) ??
          this.parseFunctionArguments(item?.arguments) ??
          this.parseToolCalls(item?.tool_calls);
        if (parsed) return parsed;
      }
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).fields)
    ) {
      const map: Record<string, string> = {};
      for (const item of (json as any).fields) {
        const key = (item?.key ?? '').toString().trim();
        const value = sanitizeExtractedValue(
          item?.value == null ? '' : String(item.value),
        );
        if (!key || !value) continue;
        map[key] = value;
      }
      if (Object.keys(map).length) return map;
    }

    if (
      json &&
      typeof json === 'object' &&
      (json as any).fields &&
      typeof (json as any).fields === 'object'
    ) {
      return this.normalizeFieldMap((json as any).fields);
    }

    // Some gateways wrap into { data: {...} }
    const data = json && typeof json === 'object' ? (json as any).data : null;
    if (data && typeof data === 'object') {
      return this.parseFieldsFromResponse(data);
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).choices)
    ) {
      for (const choice of (json as any).choices) {
        const parsed = this.parseFieldsFromResponse(choice);
        if (parsed) return parsed;
      }
    }

    if (json && typeof json === 'object' && (json as any).message) {
      const parsed = this.parseFieldsFromResponse((json as any).message);
      if (parsed) return parsed;
    }

    if (json && typeof json === 'object' && (json as any).function_call) {
      const parsed = this.parseFunctionArguments((json as any).function_call);
      if (parsed) return parsed;
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as any).tool_calls)
    ) {
      const parsed = this.parseToolCalls((json as any).tool_calls);
      if (parsed) return parsed;
    }

    if (json && typeof json === 'object' && (json as any).arguments) {
      const parsed = this.parseFunctionArguments((json as any).arguments);
      if (parsed) return parsed;
    }

    if (
      json &&
      typeof json === 'object' &&
      Array.isArray(json.detectedFields)
    ) {
      const map: Record<string, string> = {};
      for (const item of json.detectedFields) {
        const key = (item?.key ?? '').toString().trim();
        const value = sanitizeExtractedValue(
          item?.value == null ? '' : String(item.value),
        );
        if (!key || !value) continue;
        map[key] = value;
      }
      return map;
    }

    return null;
  }

  async extract(
    payload: AiExtractionPayload,
  ): Promise<AiExtractionResult | null> {
    const url = this.resolveApiUrl();
    if (!url) {
      this.logger.warn(
        'AI_API_BASE_URL not configured; skipping AI extraction',
      );
      return null;
    }

    const apiKey = this.getApiKey();

    try {
      // Ensure we never pass a relative URL (Node fetch would throw "Failed to parse URL").
      try {
        // eslint-disable-next-line no-new
        new URL(url);
      } catch {
        this.logger.warn(
          `AI API URL is invalid; skipping AI extraction. Got: ${url}`,
        );
        return null;
      }

      const zipcodeHints =
        await this.addressEnrichmentService.resolveZipcodeHints({
          combinedText: payload.combinedText,
          emailSubject: payload.subject,
          detectedFields: payload.detectedFields,
        });
      const enrichedDetectedFields = this.mergeDetectedFields(
        payload.detectedFields,
        zipcodeHints,
      );
      const hintedKeys = new Set<string>(
        zipcodeHints.map((field) => field.key),
      );
      const enrichedMissingFields = (payload.missingFields ?? []).filter(
        (field) => !hintedKeys.has(field.key),
      );

      const timeoutMs = Number(
        this.configService.get<string>('AI_EXTRACTION_TIMEOUT_MS') || '120000',
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Legacy path (preserved): the rich extraction payload. The new flow uses
      // analyzeEmail() with the raw .eml instead.
      const safePayload = {
        ...payload,
        customerEmail:
          payload.customerEmail != null
            ? payload.customerEmail
            : ((payload.emailMetadata as any)?.customerEmail ?? null),
        subject: this.maybeFixMojibake(payload.subject),
        bodyText: this.maybeFixMojibake(payload.bodyText),
        attachmentsText: this.maybeFixMojibake(payload.attachmentsText),
        combinedText: this.maybeFixMojibake(payload.combinedText),
        detectedFields: enrichedDetectedFields,
        missingFields: enrichedMissingFields,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(safePayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const contentType = res.headers.get('content-type') || '';
      const rawText = contentType.includes('application/json')
        ? null
        : await res.text();
      const raw = contentType.includes('application/json')
        ? await res.json()
        : { raw: rawText };

      if (!res.ok) {
        const rawStr =
          typeof raw === 'string'
            ? raw
            : (() => {
                try {
                  return JSON.stringify(raw);
                } catch {
                  return '[unserializable response]';
                }
              })();
        const preview =
          rawStr.length > 1200 ? `${rawStr.slice(0, 1200)}…` : rawStr;
        this.logger.warn(
          `AI extraction API error: status=${res.status} url=${url} orderId=${payload.orderId} responsePreview=${preview}`,
        );
        return null;
      }

      // Some gateways respond 200 with plain XML in the body; support that.
      const fields =
        this.parseFieldsFromResponse(raw) ??
        (rawText ? this.tryParseFieldsFromXmlText(rawText) : null) ??
        null;
      if (!fields || Object.keys(fields).length === 0) {
        this.logger.warn(
          `AI extraction API returned no fields: orderId=${payload.orderId}`,
        );
        return null;
      }

      // Guardrail: ignore common LLM wrapper keys if the endpoint returns an unexpected shape.
      const badWrapperKeys = ['model', 'prompt', 'output', 'usage'];
      const fieldKeys = Object.keys(fields);
      if (fieldKeys.every((k) => badWrapperKeys.includes(k))) {
        this.logger.warn(
          `AI extraction API returned wrapper keys instead of order fields: orderId=${payload.orderId} keys=${fieldKeys.join(',')}`,
        );
        return null;
      }

      const responseDetectedFields = this.mergeDetectedFields(
        this.parseDetectedFieldsFromResponse(raw),
        zipcodeHints,
      );
      const responseMissingFields = this.parseMissingFieldsFromResponse(raw).filter(
        (field) => !hintedKeys.has(field.key),
      );
      for (const hint of zipcodeHints) {
        if (!fields[hint.key]) {
          fields[hint.key] = hint.value;
        }
      }

      return {
        fields,
        detectedFields: responseDetectedFields,
        missingFields: responseMissingFields,
        rawResponse: raw,
      };
    } catch (err: any) {
      this.logger.warn(
        `AI extraction request failed for orderId=${payload.orderId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * New flow: send ONLY the raw email (.eml) and let the AI classify + extract.
   * Returns the classification plus the orders it found (1 or many), or null on
   * failure (caller decides how to handle — must NOT lose the email).
   */
  async analyzeEmail(
    eml: string | null | undefined,
    options?: {
      detectedFields?: AiPreDetectedField[];
      customerProfile?: AiCustomerProfileContext | null;
    },
  ): Promise<AiEmailAnalysis | null> {
    const url = this.resolveEmlProcessUrl();
    if (!url) {
      this.logger.warn('AI_API_BASE_URL not configured; skipping AI analysis');
      return null;
    }
    if (!eml) {
      this.logger.warn('No raw email (.eml) available; skipping AI analysis');
      return null;
    }
    try {
      new URL(url);
    } catch {
      this.logger.warn(`AI API URL is invalid; skipping AI analysis. Got: ${url}`);
      return null;
    }

    const apiKey = this.getApiKey();
    const timeoutMs = Number(
      this.configService.get<string>('AI_EXTRACTION_TIMEOUT_MS') || '120000',
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Built ONCE and echoed back on the result, so the audit trail shows the
      // exact body we sent instead of a hand-rebuilt copy that can drift.
      const requestBody = {
        emlBase64: eml,
        ...(options?.detectedFields?.length
          ? { detectedFields: options.detectedFields }
          : {}),
        // Customer-specific extraction guidance (how THIS client builds their
        // documents). Only sent when the profile actually carries hints.
        ...(options?.customerProfile?.instructions
          ? { customerProfile: options.customerProfile }
          : {}),
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        this.logger.warn(
          `AI analysis API error: status=${res.status} url=${url} body=${(text || '').slice(0, 1000)}`,
        );
        return null;
      }
      let raw: any = null;
      try {
        raw = JSON.parse(text);
      } catch {
        this.logger.warn(
          `AI analysis returned non-JSON: ${(text || '').slice(0, 500)}`,
        );
        return null;
      }
      const analysis = this.parseEmailAnalysis(raw);
      if (analysis) {
        // Keep the payload light: the full base64 would bloat the audit row.
        analysis.requestPreview = {
          ...requestBody,
          emlBase64: `${String(eml).slice(0, 120)}…(${String(eml).length} bytes)`,
        };
      }
      return analysis;
    } catch (err: any) {
      clearTimeout(timeout);
      this.logger.warn(`AI analysis request failed: ${err?.message ?? err}`);
      return null;
    }
  }

  private parseEmailAnalysis(raw: any): AiEmailAnalysis | null {
    if (!raw || typeof raw !== 'object') return null;
    const ordersRaw = Array.isArray(raw.orders) ? raw.orders : [];
    const orders: AiOrderResult[] = ordersRaw
      .filter(
        (o: any) => o && typeof o === 'object' && o.fields && typeof o.fields === 'object',
      )
      .map((o: any) => ({
        externalReference:
          o.externalReference != null ? String(o.externalReference).trim() : null,
        fields: this.normalizeAiFields(o.fields),
      }));
    return {
      isTransportOrder: Boolean(raw.isTransportOrder),
      confidence: Number(raw.confidence) || 0,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      language: typeof raw.language === 'string' ? raw.language : null,
      orders,
      rawResponse: raw,
    };
  }

  private normalizeAiFields(
    fields: Record<string, unknown>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      const s = sanitizeExtractedValue(String(v)).trim();
      if (s) out[k] = s;
    }
    return out;
  }

  async extractTransportOrder(orderId: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: {
          include: {
            attachments: true,
          },
        },
        fields: true,
        missingFields: true,
      },
    });

    if (!order) throw new Error(`TransportOrder not found: id=${orderId}`);
    if (!order.emailMessage) {
      throw new Error(`EmailMessage not found for orderId=${orderId}`);
    }

    const email = order.emailMessage as any;
    const attachments = (email.attachments ?? []).map((a: any) => ({
      fileName: a.fileName ?? null,
      mimeType: a.mimeType ?? null,
      extractedText: a.extractedText ?? null,
      extractionStatus: a.extractionStatus ?? null,
    }));

    const combinedText = this.buildCombinedText({
      subject: email.subject ?? null,
      bodyText: email.bodyText ?? null,
      bodyHtml: email.bodyHtml ?? null,
      attachments: attachments.map((a: any) => ({
        fileName: a.fileName ?? '',
        extractedText: a.extractedText ?? null,
      })),
    });

    const technicalKeys = new Set(
      TRANSPORT_BOOKING_FIELD_RULES.filter(
        (r) => r.generated || r.calculable,
      ).map((r) => r.key),
    );

    const requiredFields = TRANSPORT_BOOKING_FIELD_RULES.filter(
      (r) => !r.generated,
    ).map((rule) => ({
      ...rule,
      required: getRuleRequirement(rule) === FieldRequirement.REQUIRED,
    }));

    const detectedFields = (order.fields ?? [])
      .filter((f: any) => (f.value ?? '').toString().trim().length > 0)
      .filter((f: any) => f?.key && !technicalKeys.has(f.key))
      .map((f: any) => ({
        key: f.key,
        label: f.label,
        value: (f.value ?? '').toString(),
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.85,
      }));

    const missingFields = (order.missingFields ?? [])
      .filter((m: any) => m?.key && !technicalKeys.has(m.key))
      .map((m: any) => ({
        key: m.key,
        label: m.label,
        reason: m.reason ?? 'Missing',
      }));

    const attachmentsText = attachments
      .map((a: any) => (a.extractedText ?? '').toString().trim())
      .filter((t: string) => t.length > 0)
      .join('\n\n');

    const payload: AiExtractionPayload = {
      orderId: order.id,
      department: order.department ?? null,
      customerEmail: order.customerEmail ?? email.fromEmail ?? null,
      subject: email.subject ?? null,
      bodyText: email.bodyText ?? null,
      attachmentsText: attachmentsText || null,
      combinedText,
      requiredFields,
      detectedFields,
      missingFields,
      language: null,
      emailMetadata: {
        fromEmail: email.fromEmail ?? null,
        fromName: email.fromName ?? null,
        receivedAt: email.receivedAt ?? null,
        attachmentsCount: attachments.length,
      },
    };

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: order.id,
      action: 'AI_EXTRACTION_REQUESTED',
      detailsJson: {
        attachmentsCount: attachments.length,
        combinedTextChars: combinedText.length,
      },
    });

    try {
      const res = await this.extract(payload);

      // Record the AI extraction call so it shows up in the order's AI requests
      // panel. Best-effort: must never break extraction itself.
      try {
        const fieldsCount = res?.fields ? Object.keys(res.fields).length : 0;
        await this.prismaService.aiRequest.create({
          data: {
            orderId: order.id,
            payloadJson: payload as any,
            responseJson: (res?.rawResponse ?? null) as any,
            status: res ? (fieldsCount > 0 ? 'SUCCEEDED' : 'EMPTY') : 'FAILED',
          },
        });
      } catch (recordErr: any) {
        this.logger.warn(
          `Failed to record AI extraction request for orderId=${order.id}: ${recordErr?.message ?? recordErr}`,
        );
      }

      if (!res?.fields || Object.keys(res.fields).length === 0) {
        throw new BadRequestException('AI extraction returned no fields');
      }

      const fieldsMap = res.fields;
      const aiDetectedByKey = new Map(
        (res.detectedFields ?? []).map((field) => [field.key, field]),
      );

      await this.prismaService.$transaction(async (tx) => {
        await tx.orderField.deleteMany({
          where: { orderId: order.id, source: OrderFieldSource.AI },
        });

        for (const [key, value] of Object.entries(fieldsMap)) {
          const cleaned = sanitizeExtractedValue(value);
          if (!cleaned) continue;
          const rule = TRANSPORT_BOOKING_FIELD_RULES.find((r) => r.key === key);
          const aiField = aiDetectedByKey.get(key);
          const label = aiField?.label ?? rule?.label ?? key;
          await tx.orderField.upsert({
            where: { orderId_key: { orderId: order.id, key } },
            create: {
              orderId: order.id,
              key,
              label,
              value: cleaned,
              source: OrderFieldSource.AI,
              required:
                (rule ? getRuleRequirement(rule) : FieldRequirement.OPTIONAL) ===
                FieldRequirement.REQUIRED,
              requirement: rule
                ? getRuleRequirement(rule)
                : FieldRequirement.OPTIONAL,
              missing: false,
              confidence: aiField?.confidence ?? 0.85,
            },
            update: {
              label,
              value: cleaned,
              source: OrderFieldSource.AI,
              required:
                (rule ? getRuleRequirement(rule) : FieldRequirement.OPTIONAL) ===
                FieldRequirement.REQUIRED,
              requirement: rule
                ? getRuleRequirement(rule)
                : FieldRequirement.OPTIONAL,
              missing: false,
              confidence: aiField?.confidence ?? 0.85,
            },
          });
        }
      });

      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: order.id,
        action: 'AI_EXTRACTION_COMPLETED',
        detailsJson: {
          fieldsCount: Object.keys(fieldsMap).length,
          missingFieldsCount: res.missingFields?.length ?? 0,
        },
      });

      return {
        ok: true,
        fieldsCount: Object.keys(fieldsMap).length,
        missingCount: res.missingFields?.length ?? 0,
        missingFields: res.missingFields ?? [],
      };
    } catch (err: any) {
      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: order.id,
        action: 'AI_EXTRACTION_FAILED',
        detailsJson: { message: err?.message ?? String(err) },
      });
      throw err;
    }
  }
}
