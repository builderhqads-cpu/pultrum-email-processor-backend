import { Injectable } from '@nestjs/common';
import { sanitizeExtractedValue } from '../../utils/sanitize';

export type RegexExtractedField = {
  key: string;
  value: string;
  confidence: number;
  source: 'REGEX';
};

export type ExistingDetectedField = {
  key: string;
  value?: string | null;
  confidence?: number | null;
  source?: 'EMAIL' | 'REGEX' | 'AI' | 'SYSTEM' | 'CALCULATED' | string;
};

const normalizeWhitespace = (value: string) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();

const parseDateToIso = (raw: string): string | null => {
  const value = sanitizeExtractedValue(raw);
  if (!value) return null;

  // yyyy-mm-dd
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y.toString().padStart(4, '0')}-${m
        .toString()
        .padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
    }
  }

  // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy (defaulting to dd/mm for EU context)
  const dmy = value.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    let y = Number(dmy[3]);
    if (y < 100) y = 2000 + y;
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y.toString().padStart(4, '0')}-${m
        .toString()
        .padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
    }
  }

  return null;
};

const parseTimeTo24h = (raw: string): string | null => {
  const value = sanitizeExtractedValue(raw);
  if (!value) return null;

  const m = value.match(/^(\d{1,2})(?::(\d{2}))\s*([AP]M)?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = (m[3] ?? '').toUpperCase();

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'AM') hour = hour === 12 ? 0 : hour;
    if (ampm === 'PM') hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const normalizeCountryCode = (raw: string): string | null => {
  const value = sanitizeExtractedValue(raw);
  if (!value) return null;
  const cleaned = value.replace(/[().,]/g, ' ').trim();

  const iso2 = cleaned.match(/^[A-Z]{2}$/);
  if (iso2) return cleaned;

  const lower = cleaned.toLowerCase();
  const map: Record<string, string> = {
    denmark: 'DK',
    deutschland: 'DE',
    germany: 'DE',
    netherlands: 'NL',
    nederland: 'NL',
    belgium: 'BE',
    belgie: 'BE',
    'belgië': 'BE',
    france: 'FR',
    spain: 'ES',
    portugal: 'PT',
    italy: 'IT',
  };

  return map[lower] ?? null;
};

const parseNumberString = (raw: string): string | null => {
  const value = sanitizeExtractedValue(raw);
  if (!value) return null;
  const m = value.replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/);
  if (!m) return null;
  return m[0];
};

const parseIntString = (raw: string): string | null => {
  const value = sanitizeExtractedValue(raw);
  if (!value) return null;
  const m = value.match(/[0-9]+/);
  if (!m) return null;
  return m[0];
};

@Injectable()
export class RegexExtractionService {
  extract(
    text: string,
    existingFields: ExistingDetectedField[] = [],
  ): RegexExtractedField[] {
    const haystack = normalizeWhitespace(text ?? '');
    if (!haystack) return [];

    const existingByKey = new Map<string, ExistingDetectedField>();
    for (const f of existingFields) {
      if (!f?.key) continue;
      existingByKey.set(f.key, f);
    }

    const out: RegexExtractedField[] = [];

    const emit = (key: string, value: string | null, confidence: number) => {
      const cleaned = sanitizeExtractedValue(value ?? '');
      if (!cleaned) return;

      const existing = existingByKey.get(key);
      const existingConfidence = existing?.confidence ?? null;
      const existingSource = (existing?.source ?? '').toString().toUpperCase();

      // Never downgrade a better (higher confidence) value, especially EMAIL.
      if (existingConfidence != null && existingConfidence > confidence) return;
      if (existingSource === 'EMAIL' && (existingConfidence ?? 0) >= confidence)
        return;

      out.push({ key, value: cleaned, confidence, source: 'REGEX' });
    };

    // References (common in unstructured emails)
    const pickupRef = haystack.match(/\bpickup\s+reference\s*:\s*([^\n\r]+?)(?:\s|$)/i);
    const deliveryRef = haystack.match(/\bdelivery\s+reference\s*:\s*([^\n\r]+?)(?:\s|$)/i);
    const invoiceRef = haystack.match(/\binvoice\s+reference\s*:\s*([^\n\r]+?)(?:\s|$)/i);
    emit('pickup_reference', pickupRef?.[1] ?? null, 0.8);
    emit('delivery_reference', deliveryRef?.[1] ?? null, 0.8);
    emit('invoice_reference', invoiceRef?.[1] ?? null, 0.8);

    // Pickup: "collected on 01/06/2026 ... at 10:00"
    const pickupDateMatch = haystack.match(/\bcollect(?:ed|ion)?\s+on\s+(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})/i);
    emit('pickup_date', pickupDateMatch ? parseDateToIso(pickupDateMatch[1]) : null, 0.82);

    const pickupTimeMatch = haystack.match(/\bcollect(?:ed|ion)?\b[^.]*?\bat\s+(\d{1,2}:\d{2}\s*[AP]M|\d{1,2}:\d{2})/i);
    emit('pickup_time', pickupTimeMatch ? parseTimeTo24h(pickupTimeMatch[1]) : null, 0.8);

    // Pickup address block
    const pickupBlock =
      haystack.match(
        /\bfrom\s+([^,]+?)\s*,\s*located\s+at\s+([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^(]+?)\s*\(zip\s*code\s*([0-9A-Za-z -]{3,12})\)/i,
      ) ??
      haystack.match(
        /\bfrom\s+([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^(]+?)\s*\(zip\s*code\s*([0-9A-Za-z -]{3,12})\)/i,
      );

    if (pickupBlock) {
      emit('pickup_name', pickupBlock[1], 0.8);
      emit('pickup_address', pickupBlock[2], 0.8);
      emit('pickup_city', pickupBlock[3], 0.78);
      emit('pickup_country', normalizeCountryCode(pickupBlock[4] ?? ''), 0.8);
      emit('pickup_zipcode', sanitizeExtractedValue(pickupBlock[5] ?? ''), 0.8);
    }

    // Delivery: "delivery should take place on 02/06/2026 at 12:00 PM to ..."
    const deliveryDateMatch = haystack.match(/\bdelivery\b[^.]*?\bon\s+(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})/i);
    emit('delivery_date', deliveryDateMatch ? parseDateToIso(deliveryDateMatch[1]) : null, 0.82);

    const deliveryTimeMatch = haystack.match(/\bdelivery\b[^.]*?\bat\s+(\d{1,2}:\d{2}\s*[AP]M|\d{1,2}:\d{2})/i);
    emit('delivery_time', deliveryTimeMatch ? parseTimeTo24h(deliveryTimeMatch[1]) : null, 0.8);

    const deliveryBlock =
      haystack.match(
        /\bto\s+([^,]+?)\s*,\s*([^,]+?)\s*,\s*([0-9A-Za-z -]{3,12})\s+([^,]+?)\s*,\s*([^.\n\r]+?)(?:\.|\s|$)/i,
      ) ??
      haystack.match(
        /\bto\s+([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^.\n\r]+?)(?:\.|\s|$)/i,
      );

    if (deliveryBlock) {
      emit('delivery_name', deliveryBlock[1], 0.8);
      emit('delivery_address', deliveryBlock[2], 0.8);

      // Variant 1 includes zipcode + city + country
      if (deliveryBlock.length >= 6) {
        emit('delivery_zipcode', deliveryBlock[3], 0.8);
        emit('delivery_city', deliveryBlock[4], 0.78);
        emit('delivery_country', normalizeCountryCode(deliveryBlock[5] ?? ''), 0.8);
      } else {
        // Best effort (no zipcode split)
        emit('delivery_city', deliveryBlock[3], 0.76);
        emit('delivery_country', normalizeCountryCode(deliveryBlock[4] ?? ''), 0.78);
      }
    }

    // Cargo: "shipment consists of 5 colli of product 1109 with a total weight of 50 kg"
    const cargoMain = haystack.match(
      /\bshipment\b[^.]*?\bconsists\s+of\s+(\d+)\s+([a-z]+)\b[^.]*?\bproduct\s+([a-z0-9-]+)\b[^.]*?\btotal\s+weight\b[^.]*?\b(\d+(?:[.,]\d+)?)\s*kg\b/i,
    );
    if (cargoMain) {
      emit('cargo_unit_amount', parseIntString(cargoMain[1]), 0.82);
      emit('cargo_unit_id', cargoMain[2], 0.78);
      emit('product_id', cargoMain[3], 0.8);
      emit('cargo_weight', parseNumberString(cargoMain[4]), 0.82);
    } else {
      const unit = haystack.match(/\b(\d+)\s+(colli|pallets?|boxes?|pieces|pcs)\b/i);
      emit('cargo_unit_amount', unit ? parseIntString(unit[1]) : null, 0.78);
      emit('cargo_unit_id', unit?.[2] ?? null, 0.76);

      const product = haystack.match(/\bproduct\s+([a-z0-9-]+)\b/i);
      emit('product_id', product?.[1] ?? null, 0.78);

      const weight = haystack.match(/\b(?:total\s+)?weight\b[^0-9]*?(\d+(?:[.,]\d+)?)\s*kg\b/i);
      emit('cargo_weight', weight ? parseNumberString(weight[1]) : null, 0.78);
    }

    // Dimensions: "20 x 20 x 90 cm" or "20x20x90 cm"
    const dims = haystack.match(
      /\b(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?:\s*cm|\s*mm|\s*m)?\b/i,
    );
    if (dims) {
      emit('length', parseNumberString(dims[1]), 0.8);
      emit('width', parseNumberString(dims[2]), 0.8);
      emit('height', parseNumberString(dims[3]), 0.8);
    }

    return out;
  }
}

