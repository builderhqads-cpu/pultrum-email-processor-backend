import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AiSplitOrder {
  externalReference: string | null;
  invoiceReference: string | null;
  rawText: string;
}

export interface AiSplitResponse {
  isBatch: boolean;
  confidence: number;
  reason: string;
  orders: AiSplitOrder[];
}

/**
 * OUR OWN batch-split fallback via OpenRouter (reuses OPENROUTER_API_KEY). This
 * is deliberately self-contained — it does NOT call the other team's model
 * router. Used only for unmapped clients, behind BATCH_SPLIT_AI_ENABLED, and
 * meant for testing while we grow deterministic per-client rules.
 */
@Injectable()
export class OpenRouterSplitService {
  private readonly logger = new Logger(OpenRouterSplitService.name);

  constructor(private readonly configService: ConfigService) {}

  enabled(): boolean {
    const raw = (
      this.configService.get<string>('BATCH_SPLIT_AI_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  private config() {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    const model = (
      this.configService.get<string>('BATCH_SPLIT_MODEL') ||
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'openai/gpt-4o-mini'
    ).trim();
    const timeoutMs = Number(
      this.configService.get<string>('OPENROUTER_TIMEOUT_MS') || '120000',
    );
    return { apiKey, model, timeoutMs };
  }

  async split(text: string): Promise<AiSplitResponse | null> {
    const { apiKey, model, timeoutMs } = this.config();
    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not configured; skipping AI split');
      return null;
    }
    if (!text?.trim()) return null;

    const prompt = [
      'You split transport dispatch documents into individual orders.',
      'A document may contain ONE order or MANY (a weekly list / batch).',
      'Identify each distinct transport order (often marked by repeated',
      'reference codes, multiple recipients, or repeated row blocks).',
      'Return ONLY strict JSON, no prose, of the shape:',
      '{"isBatch": boolean, "confidence": number, "reason": string,',
      ' "orders": [{"externalReference": string|null,',
      '   "invoiceReference": string|null, "rawText": string}]}',
      'rawText must contain only the text belonging to that order.',
      'If there is a single order, return isBatch=false and orders=[].',
      'Do not invent data. Do not output XML.',
    ].join(' ');

    const requestBody = {
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text.slice(0, 60000) },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
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
      const raw: any = await res.json().catch(() => null);
      if (!res.ok) {
        this.logger.warn(`AI split failed: status=${res.status}`);
        return null;
      }
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return null;
      return this.parse(content);
    } catch (err: any) {
      this.logger.warn(`AI split request failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parse(content: string): AiSplitResponse | null {
    try {
      const json = content.trim().replace(/^```json\s*|\s*```$/g, '');
      const obj = JSON.parse(json);
      const orders: AiSplitOrder[] = Array.isArray(obj?.orders)
        ? obj.orders
            .filter((o: any) => o && typeof o.rawText === 'string')
            .map((o: any) => ({
              externalReference: o.externalReference ?? null,
              invoiceReference: o.invoiceReference ?? null,
              rawText: String(o.rawText),
            }))
        : [];
      return {
        isBatch: Boolean(obj?.isBatch) && orders.length > 1,
        confidence: Number(obj?.confidence) || 0,
        reason: typeof obj?.reason === 'string' ? obj.reason : '',
        orders,
      };
    } catch {
      this.logger.warn('AI split returned non-JSON content');
      return null;
    }
  }
}
