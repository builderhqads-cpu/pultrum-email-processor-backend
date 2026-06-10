import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldRequirement } from '@prisma/client';
import {
  TRANSPORT_BOOKING_FIELD_RULES,
  TransportBookingFieldRule,
} from '../required-fields/transport-booking-field-rules';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import type { AiExtractionPayload } from './ai-extraction.service';

type MissingFieldItem = {
  key: string;
  label: string;
  reason?: string;
};

type DetectedFieldItem = {
  key: string;
  label: string;
  value: string;
  confidence: number;
};

type OpenRouterExtractionResult = {
  fields: Record<string, string>;
  detectedFields: DetectedFieldItem[];
  missingFields: MissingFieldItem[];
  model: string;
  usage?: unknown;
  rawResponse?: unknown;
};

type OpenRouterModelOutput = {
  detectedFields?: Array<{
    key?: string;
    label?: string;
    value?: string;
    confidence?: number;
  }>;
  missingFields?: Array<{
    key?: string;
    label?: string;
    reason?: string;
  }>;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: unknown;
};

/**
 * Keys the AI must NOT use because they are duplicates of a canonical key and
 * would let the model split a single value across synonyms. We keep them in the
 * rule catalog (finalizeFieldMap still derives them for the XML), but we do not
 * offer them to the model.
 */
const AI_CATALOG_DENYLIST = new Set(['weight', 'unit_amount', 'unit_id', 'price']);

/**
 * The full set of fields the AI is allowed to extract: everything that can be
 * read from the email text. Generated/calculated fields (edireference, barcode,
 * loading meter, volume, ...) are produced by the backend, not by the model.
 */
const EXTRACTABLE_FIELD_RULES: TransportBookingFieldRule[] =
  TRANSPORT_BOOKING_FIELD_RULES.filter(
    (rule) =>
      !rule.generated && !rule.calculable && !AI_CATALOG_DENYLIST.has(rule.key),
  );

const EXTRACTABLE_FIELD_KEYS = EXTRACTABLE_FIELD_RULES.map((rule) => rule.key);
const EXTRACTABLE_FIELD_KEY_SET = new Set(EXTRACTABLE_FIELD_KEYS);

@Injectable()
export class OpenRouterExtractionService {
  private readonly logger = new Logger(OpenRouterExtractionService.name);

  constructor(private readonly configService: ConfigService) {}

  async extractTransportOrder(
    payload: AiExtractionPayload,
  ): Promise<OpenRouterExtractionResult> {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENROUTER_API_KEY is not configured',
      );
    }

    const model = (
      this.configService.get<string>('OPENROUTER_MODEL') || 'openai/gpt-4o-mini'
    ).trim();
    const timeoutMs = Number(
      this.configService.get<string>('OPENROUTER_TIMEOUT_MS') || '120000',
    );

    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt(),
        },
        {
          role: 'user',
          content: JSON.stringify({
            orderId: payload.orderId,
            department: payload.department,
            language: payload.language,
            subject: payload.subject,
            bodyText: payload.bodyText,
            attachmentsText: payload.attachmentsText,
            combinedText: payload.combinedText,
            task: 'Extract every field listed in fieldCatalog that is explicitly supported by the email text. Put each value you find in detectedFields, and list the catalog fields you cannot support in missingFields. Use ONLY keys from fieldCatalog.',
            fieldCatalog: this.buildFieldCatalog(),
            alreadyDetected: payload.detectedFields,
            priorityFields: payload.missingFields,
          }),
        },
      ],
      provider: {
        require_parameters: true,
      },
      plugins: [{ id: 'response-healing' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'transport_order_extraction',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              detectedFields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', enum: EXTRACTABLE_FIELD_KEYS },
                    label: { type: 'string' },
                    value: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                  required: ['key', 'label', 'value', 'confidence'],
                  additionalProperties: false,
                },
              },
              missingFields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', enum: EXTRACTABLE_FIELD_KEYS },
                    label: { type: 'string' },
                    reason: { type: 'string' },
                  },
                  required: ['key', 'label', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['detectedFields', 'missingFields'],
            additionalProperties: false,
          },
        },
      },
      temperature: 0,
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const raw = this.asChatResponse(await res.json());

      if (!res.ok) {
        this.logger.warn(
          `OpenRouter extraction failed: status=${res.status} orderId=${payload.orderId}`,
        );
        throw new BadRequestException(
          `OpenRouter request failed with status ${res.status}`,
        );
      }

      const parsed = this.parseModelResponse(raw);
      const normalized = this.normalizeResult(payload, parsed);

      return {
        ...normalized,
        model,
        usage: raw?.usage,
        rawResponse: raw,
      };
    } catch (err: unknown) {
      if (
        err instanceof BadRequestException ||
        err instanceof ServiceUnavailableException
      ) {
        throw err;
      }

      this.logger.warn(
        `OpenRouter extraction request failed for orderId=${payload.orderId}: ${this.getErrorMessage(err)}`,
      );
      throw new BadRequestException(
        `OpenRouter extraction request failed: ${this.getErrorMessage(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseModelResponse(
    raw: OpenRouterChatResponse,
  ): OpenRouterModelOutput {
    const content = raw?.choices?.[0]?.message?.content;

    if (typeof content === 'string' && content.trim()) {
      try {
        return JSON.parse(content) as OpenRouterModelOutput;
      } catch {
        throw new BadRequestException('OpenRouter returned non-JSON content');
      }
    }

    throw new BadRequestException('OpenRouter returned an empty response');
  }

  private normalizeResult(
    payload: AiExtractionPayload,
    output: OpenRouterModelOutput,
  ) {
    // Accept any value whose key belongs to the extractable catalog. The model
    // is NOT restricted to payload.missingFields anymore — it extracts the full
    // set, and unknown/hallucinated keys are dropped here.
    const detectedFields: DetectedFieldItem[] = [];
    const detectedKeys = new Set<string>();

    for (const item of output.detectedFields ?? []) {
      const key = (item?.key ?? '').toString().trim();
      if (!key || !EXTRACTABLE_FIELD_KEY_SET.has(key)) continue;
      if (detectedKeys.has(key)) continue;

      const value = sanitizeExtractedValue(item?.value ?? '');
      if (!value) continue;

      const rule = EXTRACTABLE_FIELD_RULES.find((r) => r.key === key);

      detectedFields.push({
        key,
        label: sanitizeExtractedValue(item?.label ?? '') || rule?.label || key,
        value,
        confidence: this.normalizeConfidence(item?.confidence),
      });
      detectedKeys.add(key);
    }

    // Advisory missing list: every REQUIRED/RECOMMENDED catalog field we did not
    // detect. Downstream validation recomputes its own missing/warnings, so this
    // is mainly useful when the endpoint is called directly for testing.
    const modelReasonByKey = new Map<string, string>();
    for (const item of output.missingFields ?? []) {
      const key = (item?.key ?? '').toString().trim();
      if (!key) continue;
      const reason = sanitizeExtractedValue(item?.reason ?? '');
      if (reason) modelReasonByKey.set(key, reason);
    }

    const missingFields: MissingFieldItem[] = [];
    for (const rule of EXTRACTABLE_FIELD_RULES) {
      if (detectedKeys.has(rule.key)) continue;
      if (
        rule.requirement !== FieldRequirement.REQUIRED &&
        rule.requirement !== FieldRequirement.RECOMMENDED
      ) {
        continue;
      }
      missingFields.push({
        key: rule.key,
        label: rule.label,
        reason: modelReasonByKey.get(rule.key) || 'Not present in email content',
      });
    }

    const fields = Object.fromEntries(
      detectedFields.map((field) => [field.key, field.value]),
    );

    return {
      fields,
      detectedFields,
      missingFields,
    };
  }

  private normalizeConfidence(input: unknown) {
    const numeric = typeof input === 'number' ? input : Number(input);
    if (!Number.isFinite(numeric)) return 0.9;
    if (numeric < 0) return 0;
    if (numeric > 1) return 1;
    return Math.round(numeric * 100) / 100;
  }

  private buildSystemPrompt() {
    return [
      'You extract structured transport-order fields from email text.',
      'Analyze subject, bodyText, attachmentsText, and combinedText together.',
      'The email may be free-flowing prose in any language (Dutch, German, English, Portuguese). Interpret the meaning of full sentences, not only "label: value" lines.',
      'Extract EVERY field in fieldCatalog that is explicitly supported by the text.',
      'Use ONLY keys that exist in fieldCatalog. Never invent keys.',
      'Do not invent values. If a field is not supported by the text, leave it out of detectedFields and list it in missingFields.',
      'Return detectedFields for every key you can support from the email text, even recommended/optional ones.',
      'Do not return empty strings, nulls, "unknown", or placeholder values in detectedFields.',
      'Use confidence between 0 and 1.',
      'Normalize dates to YYYY-MM-DD when the date is clear.',
      'Normalize times to HH:MM 24-hour format when the time is clear.',
      'Normalize countries to ISO-2 codes when obvious, e.g. Denmark/Denemarken -> DK, Germany/Duitsland -> DE, Netherlands/Nederland -> NL, Belgium/Belgie -> BE.',
      'Keep company names and references exactly as written.',
      'For addresses, separate name, address, zipcode, city, and country when they appear in the same sentence.',
      'Map phrases like "5 colli" to cargo_unit_amount=5 and cargo_unit_id=colli.',
      'Map phrases like "63457 Hanau" to zipcode=63457 and city=Hanau separately.',
      'Examples:',
      'Sentence: "opgehaald bij E3 Spedition-Transport A/S aan de Transitvej 16 in 6330 Padborg, Denemarken. De laadreferentie is REF123."',
      'Extract: pickup_name=E3 Spedition-Transport A/S, pickup_address=Transitvej 16, pickup_zipcode=6330, pickup_city=Padborg, pickup_country=DK, pickup_reference=REF123.',
      'Sentence: "De contactpersoon voor het laden is John Hansen. Hij is bereikbaar via telefoonnummer +4512345678 en via e-mail pickup@example.com."',
      'Extract: pickup_contact=John Hansen, pickup_phone=+4512345678, pickup_email=pickup@example.com.',
      'Sentence: "De levering dient plaats te vinden op 2 juni 2026 om 12:00 uur bij Systro Gastronomie GmbH, Rodgaustrasse 7, 63457 Hanau, Duitsland. De losreferentie is LOS789."',
      'Extract: delivery_date=2026-06-02, delivery_time=12:00, delivery_name=Systro Gastronomie GmbH, delivery_address=Rodgaustrasse 7, delivery_zipcode=63457, delivery_city=Hanau, delivery_country=DE, delivery_reference=LOS789.',
      'Sentence: "5 colli van product 1109 met een totaalgewicht van 50 kilogram. De afmetingen per collo zijn 20 cm lang, 20 cm breed en 90 cm hoog."',
      'Extract: cargo_unit_amount=5, cargo_unit_id=colli, product_id=1109, cargo_weight=50, length=20, width=20, height=90.',
      'Sentence: "Het betreft standaard transport. De factuurreferentie is 1234567890 en de transportprijs bedraagt EUR 250."',
      'Extract: transport_type=standard, invoice_reference=1234567890, fixed_price=250.',
    ].join('\n');
  }

  private buildFieldCatalog() {
    return EXTRACTABLE_FIELD_RULES.map((rule) => ({
      key: rule.key,
      label: rule.label,
      requirement: rule.requirement,
      aliases: rule.aliases ?? [],
      normalization: this.normalizationHint(rule.key),
    }));
  }

  private normalizationHint(key: string): string | undefined {
    if (key.endsWith('_country')) {
      return 'Return ISO-2 country code when obvious.';
    }
    if (key.endsWith('_date')) {
      return 'Return YYYY-MM-DD.';
    }
    if (key.endsWith('_time') || key.endsWith('_time_till')) {
      return 'Return HH:MM 24-hour format.';
    }
    if (key.endsWith('_zipcode')) {
      return 'Return only the postal code.';
    }
    if (key === 'cargo_unit_id') {
      return 'Return the packaging/unit word such as colli, pallet, pcs.';
    }
    if (key === 'cargo_unit_amount') {
      return 'Return only the numeric quantity.';
    }
    if (key === 'cargo_weight') {
      return 'Return only the numeric weight (no unit).';
    }
    if (key === 'length' || key === 'width' || key === 'height') {
      return 'Return only the numeric dimension (no unit).';
    }
    if (key === 'fixed_price') {
      return 'Return only the numeric amount (no currency symbol).';
    }
    if (key === 'transport_type') {
      return 'Return a short lowercase type such as standard, express, adr.';
    }
    return undefined;
  }

  private asChatResponse(input: unknown): OpenRouterChatResponse {
    if (!this.isChatResponse(input)) {
      throw new BadRequestException('OpenRouter returned an invalid JSON body');
    }

    return input;
  }

  private getErrorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }

  private isChatResponse(input: unknown): input is OpenRouterChatResponse {
    return typeof input === 'object' && input !== null;
  }
}
