import { Injectable } from '@nestjs/common';
import { sanitizeExtractedValue } from '../../utils/sanitize';

export type FieldSource =
  | 'EMAIL'
  | 'REGEX'
  | 'ATTACHMENT'
  | 'OCR'
  | 'AI'
  | 'GENERATED'
  | 'CALCULATED';

export type MergeableField = {
  key: string;
  value: string | null | undefined;
  confidence: number | null | undefined;
  source: FieldSource;
};

export type MergedField = {
  key: string;
  value: string | null;
  confidence: number;
  source: FieldSource;
};

const toConfidence = (value: number | null | undefined, fallback: number) => {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

const normalizeValue = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const cleaned = sanitizeExtractedValue(String(value));
  return cleaned ? cleaned : null;
};

const sourcePriority: Record<FieldSource, number> = {
  // Higher wins on confidence ties
  GENERATED: 100,
  CALCULATED: 90,
  EMAIL: 80,
  ATTACHMENT: 70,
  OCR: 60,
  REGEX: 50,
  AI: 40,
};

@Injectable()
export class FieldMergeService {
  merge(inputs: MergeableField[]): MergedField[] {
    const merged = new Map<string, MergedField>();

    for (const input of inputs ?? []) {
      const key = (input?.key ?? '').toString().trim();
      if (!key) continue;

      const value = normalizeValue(input.value);
      if (value == null) continue; // "Converter vazio para null" -> ignore empty updates

      const confidence = toConfidence(input.confidence, 0);
      const source = input.source;

      const current = merged.get(key);
      if (!current) {
        merged.set(key, { key, value, confidence, source });
        continue;
      }

      // Rule: do not overwrite an EMAIL field with an AI field that has lower confidence.
      if (
        current.source === 'EMAIL' &&
        source === 'AI' &&
        confidence < current.confidence
      ) {
        continue;
      }

      if (confidence > current.confidence) {
        merged.set(key, { key, value, confidence, source });
        continue;
      }

      if (confidence < current.confidence) {
        continue;
      }

      // Tie-breaker: keep higher-priority source.
      const curP = sourcePriority[current.source] ?? 0;
      const nextP = sourcePriority[source] ?? 0;
      if (nextP > curP || nextP === curP) {
        merged.set(key, { key, value, confidence, source });
      }
    }

    return [...merged.values()];
  }
}
