import { Injectable } from '@nestjs/common';
import {
  TRANSPORT_BOOKING_FIELD_RULES,
  type TransportBookingFieldRule,
} from '../required-fields/transport-booking-field-rules';
import { sanitizeExtractedValue } from '../../utils/sanitize';

export type LabelParsedField = {
  key: string;
  value: string;
  confidence: 0.95;
  source: 'EMAIL';
};

const normalizeLabel = (label: string) =>
  (label ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

@Injectable()
export class LabelParserService {
  private readonly aliasToKeys: Map<string, string[]>;

  constructor() {
    this.aliasToKeys = this.buildAliasIndex(TRANSPORT_BOOKING_FIELD_RULES);
  }

  private buildAliasIndex(rules: TransportBookingFieldRule[]) {
    const map = new Map<string, string[]>();

    const add = (alias: string, key: string) => {
      const norm = normalizeLabel(alias);
      if (!norm) return;
      const list = map.get(norm) ?? [];
      if (!list.includes(key)) list.push(key);
      map.set(norm, list);
    };

    for (const rule of rules) {
      // Include canonical label + key + aliases for exact-match.
      add(rule.label, rule.key);
      add(rule.key, rule.key);
      for (const a of rule.aliases ?? []) add(a, rule.key);
    }

    return map;
  }

  extract(text: string): LabelParsedField[] {
    const lines = (text ?? '').split(/\r?\n/);
    const out: LabelParsedField[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Prefer the "label - value" delimiter first. Otherwise a value containing ":" (e.g. time "10:00")
      // would be misparsed as "label: value" using the colon inside the time.
      const dashMatch = line.match(/^(.+?)\s+-\s+(.+)$/);
      const colonMatch = dashMatch ? null : line.match(/^(.+?)\s*:\s*(.+)$/);
      const match = dashMatch ?? colonMatch;
      if (!match) continue;

      const label = normalizeLabel(match[1] ?? '');
      const value = sanitizeExtractedValue((match[2] ?? '').toString());
      if (!label || !value) continue;

      const keys = this.aliasToKeys.get(label);
      if (!keys?.length) continue;

      for (const key of keys) {
        out.push({
          key,
          value,
          confidence: 0.95,
          source: 'EMAIL',
        });
      }
    }

    return out;
  }
}
