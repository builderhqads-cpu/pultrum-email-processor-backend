import { Injectable, Logger } from '@nestjs/common';
import { ClientProfileService } from '../client-profiles/client-profile.service';
import type { ClientProfile } from '../client-profiles/client-profile.types';
import { OpenRouterSplitService } from './openrouter-split.service';
import type { OrderChunk, SplitResult } from './order-split.types';

const SINGLE: SplitResult = {
  isBatch: false,
  source: 'single',
  reason: 'No batch detected',
  orders: [],
};

@Injectable()
export class OrderSplitService {
  private readonly logger = new Logger(OrderSplitService.name);

  constructor(
    private readonly clientProfiles: ClientProfileService,
    private readonly aiSplit: OpenRouterSplitService,
  ) {}

  /**
   * Decide whether a message contains multiple orders and split them.
   * Rules-first (per-client deterministic strategy), then OUR OWN AI fallback
   * (OpenRouter, flagged), otherwise treat as a single order.
   */
  async split(input: {
    fromEmail?: string | null;
    bodyText?: string | null;
    combinedText?: string | null;
  }): Promise<SplitResult> {
    const text = (input.combinedText || input.bodyText || '').toString();
    if (!text.trim()) return SINGLE;

    const profile = this.clientProfiles.resolve({
      fromEmail: input.fromEmail,
      bodyText: input.bodyText,
      text,
    });

    // 1) Deterministic per-client strategy.
    if (
      profile?.split?.mode === 'deterministic' &&
      profile.split.strategy === 'derix-tr-lt'
    ) {
      const result = this.derixTrLtSplit(text, profile);
      if (result.isBatch) return result;
    }

    // 2) Our own AI fallback (no external dependency), for unmapped clients.
    if (this.aiSplit.enabled()) {
      const ai = await this.aiSplit.split(text);
      if (ai?.isBatch && ai.orders.length > 1) {
        return {
          isBatch: true,
          source: 'heuristic',
          reason: ai.reason || 'AI detected multiple orders',
          orders: ai.orders.map((o, i) => ({
            sequence: i + 1,
            externalReference: o.externalReference,
            invoiceReference: o.invoiceReference,
            rawText: o.rawText.trim(),
            derivedFields: profile
              ? this.clientProfiles.derive(profile, o.rawText)
              : {},
          })),
        };
      }
    }

    return SINGLE;
  }

  /**
   * Derix "Dispo" split: each TR block is an order; multiple LT lines inside a
   * block (deellading) are separate orders/stops. Excluded routes are dropped.
   */
  private derixTrLtSplit(text: string, profile: ClientProfile): SplitResult {
    const trRe = /\b\d{2}TR\d{6}\b/g;
    const trMatches = [...text.matchAll(trRe)];
    if (trMatches.length === 0) {
      return { isBatch: false, source: 'derix-tr-lt', reason: 'no TR blocks', orders: [] };
    }

    const chunks: OrderChunk[] = [];
    let seq = 0;

    // One order per TR block. A TR block holds BOTH the load row and the
    // delivery row (often sharing the same LT number), so it must stay together
    // — splitting by LT would tear load/delivery apart and lose data.
    for (let i = 0; i < trMatches.length; i++) {
      const start = trMatches[i].index ?? 0;
      const end =
        i + 1 < trMatches.length ? (trMatches[i + 1].index ?? text.length) : text.length;
      const block = text.slice(start, end);
      const tr = trMatches[i][0];
      const ba = block.match(/\b\d{2}BA\d{6}\b/)?.[0] ?? null;
      const lt = block.match(/\bLT[A-Z0-9.]+\b/)?.[0] ?? null; // for the reference label only
      chunks.push(this.makeChunk(++seq, tr, lt, ba, block, profile));
    }

    const kept = this.applyExclude(chunks, profile);
    if (kept.length !== chunks.length) {
      this.logger.log(
        `derix-tr-lt: excluded ${chunks.length - kept.length} order(s) by rule`,
      );
    }
    // Re-sequence after exclusions.
    kept.forEach((c, i) => (c.sequence = i + 1));

    return {
      isBatch: kept.length > 1,
      source: 'derix-tr-lt',
      reason: `${kept.length} order(s), one per TR block`,
      orders: kept,
    };
  }

  private makeChunk(
    sequence: number,
    tr: string,
    lt: string | null,
    ba: string | null,
    rawText: string,
    profile: ClientProfile,
  ): OrderChunk {
    const reference = lt ? `${tr} ${lt}` : tr;
    const derived = this.clientProfiles.derive(profile, rawText);
    return {
      sequence,
      externalReference: lt ? `${tr}-${lt}` : tr,
      invoiceReference: ba,
      rawText: rawText.trim(),
      derivedFields: {
        ...derived,
        ...(ba ? { invoice_reference: ba } : {}),
        // Laad/Losreferentie = TR + LT.
        pickup_reference: reference,
        delivery_reference: reference,
      },
    };
  }

  private applyExclude(chunks: OrderChunk[], profile: ClientProfile): OrderChunk[] {
    const routes = profile.exclude?.routePatterns ?? [];
    const partners = profile.exclude?.partnerPatterns ?? [];
    if (routes.length === 0 && partners.length === 0) return chunks;
    return chunks.filter((c) => {
      const t = c.rawText;
      const hit =
        routes.some((r) => new RegExp(r, 'i').test(t)) ||
        partners.some((p) => new RegExp(p, 'i').test(t));
      return !hit;
    });
  }
}
