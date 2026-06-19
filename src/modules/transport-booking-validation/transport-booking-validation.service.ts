import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  EmailMessage,
  FieldRequirement,
  OrderFieldSource,
  OrderStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_AI_REQUEST, QUEUE_XML_DELIVERY } from '../queues/queue-names';
import {
  getRuleRequirement,
  TRANSPORT_BOOKING_FIELD_RULES,
  TransportBookingFieldRule,
} from '../required-fields/transport-booking-field-rules';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import { normalizeFieldMap, parseDecimal } from '../../utils/field-normalize';
import { SystemSettingsService } from '../system-settings/system-settings.service';

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, ' ').trim();

export const normalizeLabel = (label: string) =>
  (label ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents/diacritics
    .toLowerCase()
    .replace(/[._]+$/g, '') // strip trailing punctuation like "." or "_" (common in replies)
    .trim()
    .replace(/\s+/g, ' ');

/**
 * Robust label extraction:
 * - line-based
 * - supports "Label: value" and "Label - value" (dash requires surrounding spaces)
 * - normalizes labels to avoid accent/case/whitespace mismatches
 * - returns a map of normalizedLabel -> value (last wins)
 */
export function extractLabeledFields(text: string) {
  const result = new Map<string, string>();
  const lines = (text ?? '').split(/\r\n|\n|\r/);
  let pendingLabel: string | null = null;
  let pendingValueLines: string[] = [];
  const isLikelyLabel = (candidate: string) => {
    const trimmed = (candidate ?? '').trim();
    if (!trimmed) return false;
    if (/[[@\]()]/.test(trimmed)) return false;
    return /[A-Za-zÀ-ÿ]/.test(trimmed);
  };

  const flushPending = () => {
    if (!pendingLabel || !pendingValueLines.length) {
      pendingLabel = null;
      pendingValueLines = [];
      return;
    }

    const value = sanitizeExtractedValue(pendingValueLines.join('\n'));
    if (value) {
      result.set(pendingLabel, normalizeWhitespace(value));
    }

    pendingLabel = null;
    pendingValueLines = [];
  };

  for (const rawLine of lines) {
    // Strip common quote prefixes (email clients often prefix reply lines with ">")
    const line = rawLine.replace(/^\s*[>\u00bb]+\s*/g, '').trim();
    if (!line) {
      if (pendingLabel && pendingValueLines.length) flushPending();
      continue;
    }

    const colonMatch = line.match(/^(.+?)\s*:\s*(.*)$/);
    const dashMatch = colonMatch ? null : line.match(/^(.+?)\s+-\s*(.*)$/);
    const match = colonMatch ?? dashMatch;
    if (match && isLikelyLabel(match[1] ?? '')) {
      flushPending();

      const label = normalizeLabel(match[1] ?? '');
      const value = sanitizeExtractedValue((match[2] ?? '').toString());
      if (!label) continue;

      if (value) {
        result.set(label, normalizeWhitespace(value));
      } else {
        pendingLabel = label;
      }
      continue;
    }

    if (pendingLabel) {
      pendingValueLines.push(line);
    }
  }

  flushPending();

  return result;
}

/**
 * Ambiguous single-token aliases that must NOT drive the catalog fallback —
 * they would grab the wrong value (e.g. a bare "Reference:" line holding the
 * PULTRUM token, or loose "till"/"unit"/"weight"/"price"). When these genuinely
 * need to be mapped, the curated labelToKeys map handles them explicitly.
 */
const AMBIGUOUS_FALLBACK_ALIASES = new Set([
  'till',
  'ref',
  'reference',
  'price',
  'weight',
  'unit',
  'units',
  'goods',
  'cargo',
  'notes',
  'remarks',
  'instructions',
  'sender',
  'permit',
  'permits',
  'escort',
  'quantity',
  'product',
]);

/**
 * Alias -> field keys index built from the field catalog. Used as a fallback
 * when an extracted label is not present in the curated labelToKeys map, so the
 * catalog and the deterministic parser cannot silently drift apart. Very short
 * (< 4 chars) and ambiguous aliases are skipped to avoid mismapping.
 */
export const ALIAS_FALLBACK_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  const add = (alias: string | undefined, key: string) => {
    const norm = normalizeLabel(alias ?? '');
    if (!norm || norm.length < 4) return;
    if (AMBIGUOUS_FALLBACK_ALIASES.has(norm)) return;
    const list = index.get(norm) ?? [];
    if (!list.includes(key)) list.push(key);
    index.set(norm, list);
  };
  for (const rule of TRANSPORT_BOOKING_FIELD_RULES) {
    add(rule.label, rule.key);
    for (const alias of rule.aliases ?? []) add(alias, rule.key);
  }
  return index;
})();

export type TransportBookingValidationResult = {
  detectedFields: Array<{
    key: string;
    label: string;
    value: string;
    confidence: number;
    source?: OrderFieldSource;
  }>;
  missingFields: Array<{
    key: string;
    label: string;
    requirement: FieldRequirement;
    reason: string;
  }>;
  validationWarnings: Array<{
    key: string;
    label: string;
    requirement: FieldRequirement;
    reason: string;
  }>;
  isComplete: boolean;
  overallConfidence: number;
};

@Injectable()
export class TransportBookingValidationService {
  private readonly logger = new Logger(TransportBookingValidationService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_AI_REQUEST)
    private readonly aiRequestQueue: Queue,
    @InjectQueue(QUEUE_XML_DELIVERY)
    private readonly xmlDeliveryQueue: Queue,
    private readonly systemSettingsService: SystemSettingsService,
  ) {}

  /**
   * Auto-enqueue XML delivery only when the current operation mode allows it.
   * MANUAL never auto-delivers; SELECTIVE requires confidence >= threshold;
   * AUTONOMOUS always. The manual "Send XML" action bypasses this entirely.
   */
  private async maybeAutoEnqueueXml(
    orderId: string,
    overallConfidence: number | null | undefined,
  ) {
    const allowed =
      await this.systemSettingsService.shouldAutoDeliver(overallConfidence);
    if (allowed) {
      await this.enqueueXmlDelivery(orderId);
    } else {
      this.logger.log(
        `Auto XML delivery skipped by operation mode orderId=${orderId}`,
      );
    }
  }

  private boolEnv(name: string, defaultValue = false) {
    const raw = (this.configService.get<string>(name) ?? '').trim();
    if (!raw) return defaultValue;
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  private normalizeWhitespace(value: string) {
    return normalizeWhitespace(value);
  }

  private parseNumber(value: string | null | undefined) {
    return parseDecimal(value);
  }

  private calcVolume(params: {
    length: string | null | undefined;
    width: string | null | undefined;
    height: string | null | undefined;
    unitAmount: string | null | undefined;
  }) {
    const length = this.parseNumber(params.length);
    const width = this.parseNumber(params.width);
    const height = this.parseNumber(params.height);
    const unitAmount = this.parseNumber(params.unitAmount);

    if (length == null || width == null || height == null || unitAmount == null)
      return null;

    // Simple heuristic: treat values > 10 as centimeters, otherwise meters.
    const toMeters = (v: number) => (v > 10 ? v / 100 : v);
    const volume =
      toMeters(length) * toMeters(width) * toMeters(height) * unitAmount;
    return Number.isFinite(volume) ? volume : null;
  }

  private calcLoadingMeterCm(params: {
    length: string | null | undefined;
    width: string | null | undefined;
    unitAmount: string | null | undefined;
  }) {
    const length = this.parseNumber(params.length);
    const width = this.parseNumber(params.width);
    const unitAmount = this.parseNumber(params.unitAmount);

    if (length == null || width == null || unitAmount == null) return null;

    // Rule requested: (length * width * unit_amount) / 24000, considering cm.
    // If user provides meters, this will be off; keep it simple for now.
    const ldm = (length * width * unitAmount) / 24000;
    return Number.isFinite(ldm) ? ldm : null;
  }

  private generateEdiReference() {
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `EDI-${ts}${rnd}`;
  }

  private buildRenovoToken(orderId: string) {
    const short = (orderId || '').split('-')[0] || '';
    if (!short) return null;
    return `PULTRUM-${short}`;
  }

  private ruleRequirement(rule: TransportBookingFieldRule) {
    if (rule.key === 'customer_id') {
      return this.boolEnv('CREATIVE_GEARS_REQUIRE_CUSTOMER_ID', false)
        ? FieldRequirement.REQUIRED
        : FieldRequirement.OPTIONAL;
    }
    return getRuleRequirement(rule);
  }

  private isRequired(rule: TransportBookingFieldRule) {
    return this.ruleRequirement(rule) === FieldRequirement.REQUIRED;
  }

  private async enqueueXmlDelivery(orderId: string) {
    const jobId = `xml-delivery_${orderId}`;

    const getJob = (this.xmlDeliveryQueue as any)?.getJob as
      | ((id: string) => Promise<any>)
      | undefined;
    if (getJob) {
      const existing = await getJob.call(this.xmlDeliveryQueue, jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        }
      }
    }

    await this.xmlDeliveryQueue.add('xml-delivery', { orderId }, { jobId });
    this.logger.log(`Enqueued xml-delivery for orderId=${orderId}`);
  }

  /**
   * Robust label extraction:
   * - line-based
   * - supports "Label: value" and "Label - value" (dash requires surrounding spaces)
   * - normalizes labels to avoid accent/case/whitespace mismatches
   * - returns a map of normalizedLabel -> value (last wins)
   */
  extractLabeledFields(text: string) {
    return extractLabeledFields(text);
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

  private finalizeFieldMap(input: {
    baseMap: Map<string, string>;
    baseConfidenceByKey?: Map<string, number>;
    baseSourceByKey?: Map<string, OrderFieldSource>;
    orderId: string;
    emailSubject: string;
  }) {
    const map = new Map<string, string>(
      Array.from(input.baseMap.entries()).map(([k, v]) => [
        k,
        sanitizeExtractedValue(v ?? ''),
      ]),
    );

    const confidenceByKey =
      input.baseConfidenceByKey ?? new Map<string, number>();
    const sourceByKey =
      input.baseSourceByKey ?? new Map<string, OrderFieldSource>();

    // Generated fields
    const edireference =
      sanitizeExtractedValue(map.get('edireference') || '') ||
      this.generateEdiReference();
    map.set('edireference', edireference);
    confidenceByKey.set('edireference', 1.0);
    map.set(
      'shipment_edireference',
      map.get('shipment_edireference') || edireference,
    );
    confidenceByKey.set('shipment_edireference', 1.0);

    // Barcode is NOT auto-generated: only keep an explicitly provided value,
    // otherwise it goes out blank (avoids "barcodes from nowhere" noise).
    map.set('barcode', sanitizeExtractedValue(map.get('barcode') || ''));
    confidenceByKey.set('barcode', 1.0);

    // Calculated / derived fields
    const reference =
      sanitizeExtractedValue(
        map.get('reference') || map.get('invoice_reference') || '',
      ) ||
      sanitizeExtractedValue(input.emailSubject || '') ||
      '';
    map.set('reference', reference);
    if (reference)
      confidenceByKey.set('reference', confidenceByKey.get('reference') ?? 0.9);

    const pickupRef = map.get('pickup_reference') || '';
    const deliveryRef = map.get('delivery_reference') || '';
    map.set(
      'shipment_reference',
      map.get('shipment_reference') || deliveryRef || pickupRef || '',
    );
    if (map.get('shipment_reference')) {
      confidenceByKey.set(
        'shipment_reference',
        confidenceByKey.get('shipment_reference') ?? 0.9,
      );
    }

    map.set(
      'external_shipment_id',
      sanitizeExtractedValue(
        map.get('external_shipment_id') ||
          map.get('invoice_reference') ||
          map.get('reference') ||
          '',
      ),
    );
    if (map.get('external_shipment_id')) {
      confidenceByKey.set(
        'external_shipment_id',
        confidenceByKey.get('external_shipment_id') ?? 0.9,
      );
    }

    // Normalize remarks: prefer product_instructions if remarks not explicitly present
    const instr = map.get('product_instructions') || '';
    if (!map.get('pickup_remarks') && instr) map.set('pickup_remarks', instr);
    if (!map.get('delivery_remarks') && instr)
      map.set('delivery_remarks', instr);

    // Cargo/Goods derivations
    const unitAmount =
      map.get('cargo_unit_amount') || map.get('unit_amount') || '';
    const unitId = map.get('cargo_unit_id') || map.get('unit_id') || '';
    const weight = map.get('cargo_weight') || map.get('weight') || '';

    map.set('cargo_unit_amount', map.get('cargo_unit_amount') || unitAmount);
    map.set('cargo_unit_id', map.get('cargo_unit_id') || unitId);
    map.set('cargo_weight', map.get('cargo_weight') || weight);

    map.set('goods_unit_amount', map.get('goods_unit_amount') || unitAmount);
    map.set('goods_unit_id', map.get('goods_unit_id') || unitId);
    map.set('goods_weight', map.get('goods_weight') || weight);

    // Loading meter: compute when possible, otherwise leave BLANK (never "0").
    const computedLdm = this.calcLoadingMeterCm({
      length: map.get('length'),
      width: map.get('width'),
      unitAmount: map.get('cargo_unit_amount'),
    });
    if (!map.get('cargo_loading_meter')) {
      map.set(
        'cargo_loading_meter',
        computedLdm == null ? '' : computedLdm.toFixed(3),
      );
    }
    if (!map.get('goods_loading_meter')) {
      map.set('goods_loading_meter', map.get('cargo_loading_meter') || '');
    }
    confidenceByKey.set('cargo_loading_meter', 0.9);
    confidenceByKey.set('goods_loading_meter', 0.9);

    // Volume: calculable
    const volume = this.calcVolume({
      length: map.get('length'),
      width: map.get('width'),
      height: map.get('height'),
      unitAmount: map.get('cargo_unit_amount'),
    });
    if (!map.get('cargo_volume')) {
      map.set('cargo_volume', volume == null ? '' : volume.toFixed(3));
    }
    if (!map.get('goods_volume')) {
      map.set('goods_volume', map.get('cargo_volume') || '');
    }
    confidenceByKey.set('cargo_volume', 0.9);
    confidenceByKey.set('goods_volume', 0.9);

    // Final value cleanup: integer quantities, zero->blank measures, no
    // city-as-name, street-only addresses. Runs after derivations/calcs.
    normalizeFieldMap(map);

    // Keep detected list consistent with final map (so generated/calculated appear too)
    const finalDetected: TransportBookingValidationResult['detectedFields'] =
      [];
    for (const rule of TRANSPORT_BOOKING_FIELD_RULES) {
      const v = sanitizeExtractedValue((map.get(rule.key) ?? '').toString());
      if (!v && !rule.generated && !rule.calculable) continue;
      finalDetected.push({
        key: rule.key,
        label: rule.label,
        value: v,
        confidence: rule.generated
          ? 1.0
          : rule.calculable
            ? 0.9
            : (confidenceByKey.get(rule.key) ?? 0.95),
        source: rule.generated
          ? OrderFieldSource.GENERATED
          : rule.calculable
            ? OrderFieldSource.CALCULATED
            : (sourceByKey.get(rule.key) ?? OrderFieldSource.EMAIL),
      });
    }

    // Also keep non-rule fields that we explicitly map (for backward-compat / debugging).
    const extraKeys = ['unit_amount', 'unit_id', 'weight'];
    for (const key of extraKeys) {
      const v = sanitizeExtractedValue((map.get(key) ?? '').toString());
      if (!v) continue;
      if (finalDetected.some((d) => d.key === key)) continue;
      finalDetected.push({
        key,
        label: key,
        value: v,
        confidence: confidenceByKey.get(key) ?? 0.95,
        source: sourceByKey.get(key) ?? OrderFieldSource.EMAIL,
      });
    }

    const missing: TransportBookingValidationResult['missingFields'] = [];
    const validationWarnings: TransportBookingValidationResult['validationWarnings'] =
      [];
    for (const rule of TRANSPORT_BOOKING_FIELD_RULES) {
      const requirement = this.ruleRequirement(rule);

      const v = sanitizeExtractedValue(map.get(rule.key) || '');
      if (v) continue;

      if (requirement === FieldRequirement.REQUIRED) {
        // Required fields are the only blocking fields.
        missing.push({
          key: rule.key,
          label: rule.label,
          requirement,
          reason: 'Not detected in email content',
        });
        continue;
      }

      if (requirement === FieldRequirement.RECOMMENDED) {
        validationWarnings.push({
          key: rule.key,
          label: rule.label,
          requirement,
          reason: 'Recommended but not detected in email content',
        });
      }
    }

    const requiredRules = TRANSPORT_BOOKING_FIELD_RULES.filter((r) =>
      this.isRequired(r),
    );
    const perFieldConfidence = requiredRules.map((r) => {
      const found = finalDetected.find((d) => d.key === r.key);
      return found ? found.confidence : 0;
    });
    const overallConfidence =
      perFieldConfidence.length > 0
        ? perFieldConfidence.reduce((a, b) => a + b, 0) /
          perFieldConfidence.length
        : 0;

    return {
      detectedFields: finalDetected,
      missingFields: missing,
      validationWarnings,
      overallConfidence,
      isComplete: missing.length === 0,
      map,
    };
  }

  private detectFromRules(input: {
    haystack: string;
    orderId: string;
    emailSubject: string;
  }) {
    const extracted = extractLabeledFields(input.haystack);

    const normalizeCountry = (raw: string) => {
      const v = sanitizeExtractedValue(raw || '');
      if (!v) return v;

      const paren = v.match(/\(([A-Za-z]{2})\)/);
      if (paren?.[1]) return paren[1].toUpperCase();

      const two = v.trim().match(/^[A-Za-z]{2}$/);
      if (two) return v.trim().toUpperCase();

      const t = v.toLowerCase();
      if (
        t.includes('duitsland') ||
        t.includes('deutschland') ||
        t.includes('germany')
      )
        return 'DE';
      if (
        t.includes('denemarken') ||
        t.includes('danmark') ||
        t.includes('denmark')
      )
        return 'DK';
      if (t.includes('nederland') || t.includes('netherlands')) return 'NL';
      if (t.includes('belgie') || t.includes('belgië') || t.includes('belgium'))
        return 'BE';
      return v;
    };

    const normalizeZipcode = (raw: string) => {
      const v = sanitizeExtractedValue(raw || '');
      if (!v) return v;
      const m = v.match(/\b[0-9]{4,6}\b/);
      if (m?.[0]) return m[0];
      return v.trim();
    };

    // NL label -> keys mapping (exact match after normalization)
    const labelToKeys: Record<string, string[]> = {
      // Pickup (loading)
      [normalizeLabel('Laaddatum')]: ['pickup_date'],
      [normalizeLabel('Laadtijd')]: ['pickup_time'],
      [normalizeLabel('Laadreferentie')]: ['pickup_reference'],
      [normalizeLabel('Laadnaam')]: ['pickup_name'],
      [normalizeLabel('Laadadres')]: ['pickup_address'],
      [normalizeLabel('Laadland')]: ['pickup_country'],
      [normalizeLabel('Laadpostcode')]: ['pickup_zipcode'],
      [normalizeLabel('Laadplaats')]: ['pickup_city'],
      [normalizeLabel('Laad contact')]: ['pickup_contact'],
      [normalizeLabel('Laad telefoonnummer')]: ['pickup_phone'],
      [normalizeLabel('Laad e-mailadres')]: ['pickup_email'],
      [normalizeLabel('Pickup date')]: ['pickup_date'],
      [normalizeLabel('Pickup time')]: ['pickup_time'],
      [normalizeLabel('Pickup reference')]: ['pickup_reference'],
      [normalizeLabel('Pickup name')]: ['pickup_name'],
      [normalizeLabel('Pickup address')]: ['pickup_address'],
      [normalizeLabel('Pickup country')]: ['pickup_country'],
      [normalizeLabel('Pickup zipcode')]: ['pickup_zipcode'],
      [normalizeLabel('Pickup zip code')]: ['pickup_zipcode'],
      [normalizeLabel('Pickup city')]: ['pickup_city'],
      [normalizeLabel('Pickup contact')]: ['pickup_contact'],
      [normalizeLabel('Pickup phone')]: ['pickup_phone'],
      [normalizeLabel('Pickup email')]: ['pickup_email'],

      // Delivery (unloading)
      [normalizeLabel('Losdatum')]: ['delivery_date'],
      [normalizeLabel('Lostijd')]: ['delivery_time'],
      [normalizeLabel('Losreferentie')]: ['delivery_reference'],
      [normalizeLabel('Losnaam')]: ['delivery_name'],
      [normalizeLabel('Losadres')]: ['delivery_address'],
      [normalizeLabel('Losland')]: ['delivery_country'],
      [normalizeLabel('Lospostcode')]: ['delivery_zipcode'],
      [normalizeLabel('Losplaats')]: ['delivery_city'],
      [normalizeLabel('Los contact')]: ['delivery_contact'],
      [normalizeLabel('Los telefoonnummer')]: ['delivery_phone'],
      [normalizeLabel('Los e-mailadres')]: ['delivery_email'],
      [normalizeLabel('Delivery date')]: ['delivery_date'],
      [normalizeLabel('Delivery time')]: ['delivery_time'],
      [normalizeLabel('Delivery reference')]: ['delivery_reference'],
      [normalizeLabel('Delivery name')]: ['delivery_name'],
      [normalizeLabel('Delivery address')]: ['delivery_address'],
      [normalizeLabel('Delivery country')]: ['delivery_country'],
      [normalizeLabel('Delivery zipcode')]: ['delivery_zipcode'],
      [normalizeLabel('Delivery zip code')]: ['delivery_zipcode'],
      [normalizeLabel('Delivery city')]: ['delivery_city'],
      [normalizeLabel('Delivery contact')]: ['delivery_contact'],
      [normalizeLabel('Delivery phone')]: ['delivery_phone'],
      [normalizeLabel('Delivery email')]: ['delivery_email'],
      // Reply variants (delivery)
      [normalizeLabel('Postcode afleveradres')]: ['delivery_zipcode'],
      [normalizeLabel('Land afleveradres')]: ['delivery_country'],
      [normalizeLabel('Postcode aflever adres')]: ['delivery_zipcode'],
      [normalizeLabel('Land aflever adres')]: ['delivery_country'],
      [normalizeLabel('Afleverpostcode')]: ['delivery_zipcode'],
      [normalizeLabel('Afleverland')]: ['delivery_country'],

      // Cargo / goods
      [normalizeLabel('Aantal')]: [
        'unit_amount',
        'cargo_unit_amount',
        'goods_unit_amount',
      ],
      [normalizeLabel('Eenheid')]: [
        'unit_id',
        'cargo_unit_id',
        'goods_unit_id',
      ],
      [normalizeLabel('Product')]: ['product_id'],
      [normalizeLabel('Gewicht')]: ['weight', 'cargo_weight', 'goods_weight'],
      [normalizeLabel('Lengte')]: ['length'],
      [normalizeLabel('Breedte')]: ['width'],
      [normalizeLabel('Hoogte')]: ['height'],
      [normalizeLabel('Transportsoort')]: ['transport_type'],
      [normalizeLabel('Factuurreferentie')]: [
        'invoice_reference',
        'external_shipment_id',
        'reference',
      ],
      [normalizeLabel('Prijs')]: ['price'],
      [normalizeLabel('Cargo unit amount')]: [
        'unit_amount',
        'cargo_unit_amount',
        'goods_unit_amount',
      ],
      [normalizeLabel('Unit amount')]: [
        'unit_amount',
        'cargo_unit_amount',
        'goods_unit_amount',
      ],
      [normalizeLabel('Cargo unit id')]: [
        'unit_id',
        'cargo_unit_id',
        'goods_unit_id',
      ],
      [normalizeLabel('Unit id')]: [
        'unit_id',
        'cargo_unit_id',
        'goods_unit_id',
      ],
      [normalizeLabel('Product')]: ['product_id'],
      [normalizeLabel('Cargo weight')]: [
        'weight',
        'cargo_weight',
        'goods_weight',
      ],
      [normalizeLabel('Weight')]: ['weight', 'cargo_weight', 'goods_weight'],
      [normalizeLabel('Length')]: ['length'],
      [normalizeLabel('Width')]: ['width'],
      [normalizeLabel('Height')]: ['height'],
      [normalizeLabel('Transport type')]: ['transport_type'],
      [normalizeLabel('Invoice reference')]: [
        'invoice_reference',
        'external_shipment_id',
        'reference',
      ],
      [normalizeLabel('Price')]: ['price'],

      // Recommended "till" times + product description (commonly supplied in
      // customer replies; were missing from the curated map above).
      [normalizeLabel('Pickup time till')]: ['pickup_time_till'],
      [normalizeLabel('Pickup time to')]: ['pickup_time_till'],
      [normalizeLabel('Laadtijd tot')]: ['pickup_time_till'],
      [normalizeLabel('Delivery time till')]: ['delivery_time_till'],
      [normalizeLabel('Delivery time to')]: ['delivery_time_till'],
      [normalizeLabel('Lostijd tot')]: ['delivery_time_till'],
      [normalizeLabel('Aflevertijd tot')]: ['delivery_time_till'],
      [normalizeLabel('Product description')]: ['product_description'],
      [normalizeLabel('Productomschrijving')]: ['product_description'],
    };

    const baseMap = new Map<string, string>();
    const confidenceByKey = new Map<string, number>();
    const sourceByKey = new Map<string, OrderFieldSource>();

    for (const [label, value] of extracted.entries()) {
      // Curated map first; fall back to the catalog alias index so new fields
      // don't silently go undetected just because the curated map missed them.
      const keys = labelToKeys[label] ?? ALIAS_FALLBACK_INDEX.get(label) ?? null;
      if (!keys?.length) continue;
      for (const key of keys) {
        const cleaned = sanitizeExtractedValue(value);
        const normalized = key.endsWith('_country')
          ? normalizeCountry(cleaned)
          : key.endsWith('_zipcode')
            ? normalizeZipcode(cleaned)
            : cleaned;
        baseMap.set(key, normalized);
        confidenceByKey.set(key, 0.95);
        sourceByKey.set(key, OrderFieldSource.EMAIL);
      }
    }

    return this.finalizeFieldMap({
      baseMap,
      baseConfidenceByKey: confidenceByKey,
      baseSourceByKey: sourceByKey,
      orderId: input.orderId,
      emailSubject: input.emailSubject,
    });
  }

  async validateOrderFromFieldValues(
    params: {
      orderId: string;
      emailMessageId: string;
      emailSubject: string;
      fieldValues: Record<string, unknown>;
      source: 'ai' | 'email';
      fieldMetaByKey?: Record<
        string,
        {
          confidence?: number | null;
          source?: OrderFieldSource;
        }
      >;
    },
    options?: { enqueueJobs?: boolean; incompleteStatus?: OrderStatus },
  ): Promise<TransportBookingValidationResult> {
    const baseMap = new Map<string, string>();
    const confidenceByKey = new Map<string, number>();
    const sourceByKey = new Map<string, OrderFieldSource>();
    const baseConfidence = params.source === 'ai' ? 0.85 : 0.95;
    const defaultSource =
      params.source === 'ai' ? OrderFieldSource.AI : OrderFieldSource.EMAIL;

    for (const [k, v] of Object.entries(params.fieldValues ?? {})) {
      const key = (k ?? '').toString().trim();
      if (!key) continue;
      const value = sanitizeExtractedValue(v == null ? '' : String(v));
      if (!value) continue;
      baseMap.set(key, value);
      confidenceByKey.set(
        key,
        params.fieldMetaByKey?.[key]?.confidence ?? baseConfidence,
      );
      sourceByKey.set(
        key,
        params.fieldMetaByKey?.[key]?.source ?? defaultSource,
      );
    }

    const {
      detectedFields,
      missingFields,
      validationWarnings,
      overallConfidence,
      isComplete,
    } = this.finalizeFieldMap({
      baseMap,
      baseConfidenceByKey: confidenceByKey,
      baseSourceByKey: sourceByKey,
      orderId: params.orderId,
      emailSubject: params.emailSubject,
    });

    await this.prismaService.$transaction(async (tx) => {
      const renovoToken = this.buildRenovoToken(params.orderId);
      await tx.transportOrder.update({
        where: { id: params.orderId },
        data: {
          overallConfidence,
          status: isComplete
            ? OrderStatus.READY_TO_XML
            : (options?.incompleteStatus ??
              OrderStatus.WAITING_CUSTOMER_RESPONSE),
          renovoToken,
        },
      });

      await tx.missingField.deleteMany({ where: { orderId: params.orderId } });
      await tx.validationWarning.deleteMany({
        where: { orderId: params.orderId },
      });
      if (missingFields.length) {
        await tx.missingField.createMany({
          data: missingFields.map((m) => ({
            orderId: params.orderId,
            key: m.key,
            label: m.label,
            requirement: m.requirement,
            reason: m.reason,
          })),
        });
      }

      if (validationWarnings.length) {
        await tx.validationWarning.createMany({
          data: validationWarnings.map((warning) => ({
            orderId: params.orderId,
            key: warning.key,
            label: warning.label,
            requirement: warning.requirement,
            reason: warning.reason,
          })),
        });
      }

      for (const rule of TRANSPORT_BOOKING_FIELD_RULES) {
        const found = detectedFields.find((d) => d.key === rule.key) ?? null;
        const ruleRequirement = this.ruleRequirement(rule);
        const isMissing =
          missingFields.some((m) => m.key === rule.key) ||
          validationWarnings.some((warning) => warning.key === rule.key);
        await tx.orderField.upsert({
          where: { orderId_key: { orderId: params.orderId, key: rule.key } },
          create: {
            orderId: params.orderId,
            key: rule.key,
            label: rule.label,
            value: found?.value ?? null,
            source:
              found?.source ??
              (rule.generated
                ? OrderFieldSource.GENERATED
                : rule.calculable
                  ? OrderFieldSource.CALCULATED
                  : defaultSource),
            required: ruleRequirement === FieldRequirement.REQUIRED,
            requirement: ruleRequirement,
            missing: isMissing,
            confidence: found?.confidence ?? null,
          },
          update: {
            label: rule.label,
            value: found?.value ?? null,
            source:
              found?.source ??
              (rule.generated
                ? OrderFieldSource.GENERATED
                : rule.calculable
                  ? OrderFieldSource.CALCULATED
                  : defaultSource),
            required: ruleRequirement === FieldRequirement.REQUIRED,
            requirement: ruleRequirement,
            missing: isMissing,
            confidence: found?.confidence ?? null,
          },
        });
      }

      for (const d of detectedFields) {
        const rule = TRANSPORT_BOOKING_FIELD_RULES.find((r) => r.key === d.key);
        if (rule) continue;
        if (!d.value?.toString().trim()) continue;

        await tx.orderField.upsert({
          where: { orderId_key: { orderId: params.orderId, key: d.key } },
          create: {
            orderId: params.orderId,
            key: d.key,
            label: d.label,
            value: d.value,
            source: d.source ?? defaultSource,
            required: false,
            requirement: FieldRequirement.OPTIONAL,
            missing: false,
            confidence: d.confidence,
          },
          update: {
            label: d.label,
            value: d.value,
            source: d.source ?? defaultSource,
            required: false,
            requirement: FieldRequirement.OPTIONAL,
            missing: false,
            confidence: d.confidence,
          },
        });
      }
    });

    const enqueueJobs = options?.enqueueJobs ?? true;
    if (enqueueJobs) {
      if (!isComplete) {
        await this.aiRequestQueue.add(
          'ai-request',
          { orderId: params.orderId, emailMessageId: params.emailMessageId },
          { jobId: `ai-request_${params.orderId}` },
        );
        this.logger.log(`Enqueued ai-request for orderId=${params.orderId}`);
      } else {
        await this.maybeAutoEnqueueXml(params.orderId, overallConfidence);
      }
    }

    return {
      detectedFields,
      missingFields,
      validationWarnings,
      isComplete,
      overallConfidence,
    };
  }

  async validateOrder(
    orderId: string,
  ): Promise<TransportBookingValidationResult> {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: {
          include: {
            attachments: { select: { fileName: true, extractedText: true } },
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

    const combinedText = this.buildCombinedText({
      subject: order.emailMessage.subject,
      bodyText: order.emailMessage.bodyText,
      bodyHtml: order.emailMessage.bodyHtml,
      attachments: order.emailMessage.attachments?.map((a: any) => ({
        fileName: a.fileName,
        extractedText: a.extractedText ?? null,
      })),
    });

    return await this.validateEmailContent(order.emailMessage, combinedText, {
      enqueueJobs: false,
    });
  }

  async validateEmailContent(
    email: EmailMessage,
    combinedText?: string,
    options?: { enqueueJobs?: boolean },
  ): Promise<TransportBookingValidationResult> {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { emailMessageId: email.id },
      select: { id: true },
    });
    if (!order) {
      throw new Error(
        `TransportOrder not found for emailMessageId=${email.id}`,
      );
    }

    const haystack =
      combinedText ??
      `${email.subject ?? ''}\n${email.bodyText ?? ''}\n${email.bodyHtml ?? ''}`;

    const {
      detectedFields,
      missingFields,
      validationWarnings,
      overallConfidence,
      isComplete,
    } = this.detectFromRules({
      haystack,
      orderId: order.id,
      emailSubject: email.subject ?? '',
    });

    await this.prismaService.$transaction(async (tx) => {
      const renovoToken = this.buildRenovoToken(order.id);
      await tx.transportOrder.update({
        where: { id: order.id },
        data: {
          overallConfidence,
          status: isComplete
            ? OrderStatus.READY_TO_XML
            : OrderStatus.WAITING_CUSTOMER_RESPONSE,
          renovoToken,
        },
      });

      await tx.missingField.deleteMany({ where: { orderId: order.id } });
      await tx.validationWarning.deleteMany({ where: { orderId: order.id } });
      if (missingFields.length) {
        await tx.missingField.createMany({
          data: missingFields.map((m) => ({
            orderId: order.id,
            key: m.key,
            label: m.label,
            requirement: m.requirement,
            reason: m.reason,
          })),
        });
      }

      if (validationWarnings.length) {
        await tx.validationWarning.createMany({
          data: validationWarnings.map((warning) => ({
            orderId: order.id,
            key: warning.key,
            label: warning.label,
            requirement: warning.requirement,
            reason: warning.reason,
          })),
        });
      }

      for (const rule of TRANSPORT_BOOKING_FIELD_RULES) {
        const found = detectedFields.find((d) => d.key === rule.key) ?? null;
        const ruleRequirement = this.ruleRequirement(rule);
        const isMissing =
          missingFields.some((m) => m.key === rule.key) ||
          validationWarnings.some((warning) => warning.key === rule.key);
        await tx.orderField.upsert({
          where: { orderId_key: { orderId: order.id, key: rule.key } },
          create: {
            orderId: order.id,
            key: rule.key,
            label: rule.label,
            value: found?.value ?? null,
            source:
              found?.source ??
              (rule.generated
                ? OrderFieldSource.GENERATED
                : rule.calculable
                  ? OrderFieldSource.CALCULATED
                  : OrderFieldSource.EMAIL),
            required: ruleRequirement === FieldRequirement.REQUIRED,
            requirement: ruleRequirement,
            missing: isMissing,
            confidence: found?.confidence ?? null,
          },
          update: {
            label: rule.label,
            value: found?.value ?? null,
            source:
              found?.source ??
              (rule.generated
                ? OrderFieldSource.GENERATED
                : rule.calculable
                  ? OrderFieldSource.CALCULATED
                  : OrderFieldSource.EMAIL),
            required: ruleRequirement === FieldRequirement.REQUIRED,
            requirement: ruleRequirement,
            missing: isMissing,
            confidence: found?.confidence ?? null,
          },
        });
      }

      for (const d of detectedFields) {
        const rule = TRANSPORT_BOOKING_FIELD_RULES.find((r) => r.key === d.key);
        if (rule) continue;
        if (!d.value?.toString().trim()) continue;

        await tx.orderField.upsert({
          where: { orderId_key: { orderId: order.id, key: d.key } },
          create: {
            orderId: order.id,
            key: d.key,
            label: d.label,
            value: d.value,
            source: d.source ?? OrderFieldSource.EMAIL,
            required: false,
            requirement: FieldRequirement.OPTIONAL,
            missing: false,
            confidence: d.confidence,
          },
          update: {
            label: d.label,
            value: d.value,
            source: d.source ?? OrderFieldSource.EMAIL,
            required: false,
            requirement: FieldRequirement.OPTIONAL,
            missing: false,
            confidence: d.confidence,
          },
        });
      }
    });

    const enqueueJobs = options?.enqueueJobs ?? true;
    if (enqueueJobs) {
      if (!isComplete) {
        await this.aiRequestQueue.add(
          'ai-request',
          { orderId: order.id, emailMessageId: email.id },
          { jobId: `ai-request_${order.id}` },
        );
        this.logger.log(`Enqueued ai-request for orderId=${order.id}`);
      } else {
        await this.maybeAutoEnqueueXml(order.id, overallConfidence);
      }
    }

    return {
      detectedFields,
      missingFields,
      validationWarnings,
      isComplete,
      overallConfidence,
    };
  }

  async enqueueJobsForOrder(params: {
    orderId: string;
    emailMessageId: string;
  }) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: params.orderId },
      include: { missingFields: { select: { id: true } } },
    });

    if (!order)
      throw new Error(`TransportOrder not found: id=${params.orderId}`);

    const isComplete =
      order.status === OrderStatus.READY_TO_XML &&
      (order.missingFields?.length ?? 0) === 0;

    if (!isComplete) {
      await this.aiRequestQueue.add(
        'ai-request',
        { orderId: params.orderId, emailMessageId: params.emailMessageId },
        { jobId: `ai-request_${params.orderId}` },
      );
      this.logger.log(`Enqueued ai-request for orderId=${params.orderId}`);
      return;
    }

    await this.maybeAutoEnqueueXml(params.orderId, order.overallConfidence);
  }
}
