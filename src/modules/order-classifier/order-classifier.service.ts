import { Injectable } from '@nestjs/common';
import { OrderType } from '@prisma/client';

type ClassifyInputEmail = {
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
};

export type OrderClassification = {
  type: OrderType;
  confidence: number;
  reason: string;
  originalOrderReference?: string | null;
};

@Injectable()
export class OrderClassifierService {
  private normalize(input: string) {
    return (input || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private buildHaystack(
    email: ClassifyInputEmail,
    attachmentsText?: string | null,
  ) {
    const parts = [
      email.subject ?? '',
      email.bodyText ?? '',
      email.bodyHtml ?? '',
      attachmentsText ?? '',
    ].filter(Boolean);
    return parts.join('\n\n');
  }

  private extractOriginalOrderReference(haystack: string) {
    const candidates: RegExp[] = [
      /\b(?:order(?:\s*(?:number|nr|no|#))?|booking(?:\s*(?:number|nr|no|#))?|referentie|reference|opdracht)\b\s*[:#-]?\s*([a-z0-9][a-z0-9-/]{3,40})/i,
      /\b(?:order|booking|reference)\b\s*([0-9]{5,20})\b/i,
    ];

    for (const re of candidates) {
      const m = haystack.match(re);
      const raw = (m?.[1] ?? '').toString().trim();
      if (!raw) continue;
      if (raw.includes('@')) continue;
      return raw;
    }
    return null;
  }

  classify(
    email: ClassifyInputEmail,
    attachmentsText?: string | null,
  ): OrderClassification {
    const haystack = this.buildHaystack(email, attachmentsText);
    const normalized = this.normalize(haystack);

    const modificationTerms = [
      'wijziging',
      'aanpassen',
      'change',
      'modification',
      'update',
      'correction',
      'corrigeren',
      'alteracao', // alteração
      'modificar',
    ] as const;

    const matchedTerms = modificationTerms.filter((t) =>
      normalized.includes(t),
    );
    const originalOrderReference = this.extractOriginalOrderReference(haystack);

    if (matchedTerms.length) {
      return {
        type: OrderType.MODIFICATION,
        confidence: Math.min(0.95, 0.75 + matchedTerms.length * 0.05),
        reason: `Matched modification terms: ${matchedTerms.join(', ')}`,
        originalOrderReference,
      };
    }

    // Basic NEW_ORDER hinting (optional): presence of shipping field keywords
    const newOrderSignals = [
      'pickup',
      'retirada',
      'ophalen',
      'delivery',
      'entrega',
      'aflever',
      'pallet',
      'palete',
      'weight',
      'peso',
    ];
    const signalCount = newOrderSignals.reduce(
      (acc, s) => acc + (normalized.includes(s) ? 1 : 0),
      0,
    );

    if (signalCount >= 2) {
      return {
        type: OrderType.NEW_ORDER,
        confidence: Math.min(0.9, 0.55 + signalCount * 0.05),
        reason: `Matched ${signalCount} new-order signals`,
        originalOrderReference,
      };
    }

    return {
      type: OrderType.UNKNOWN,
      confidence: 0.35,
      reason:
        'No modification terms detected and insufficient new-order signals',
      originalOrderReference,
    };
  }
}
