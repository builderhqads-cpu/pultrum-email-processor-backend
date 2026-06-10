import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AiClassificationPayload = {
  emailId: string;
  mailboxId: string;
  department: string | null;
  from: string | null;
  subject: string | null;
  bodyText: string | null;
  attachmentsText: string | null;
  combinedText: string;
};

export type AiClassificationResult = {
  isTransportOrder: boolean;
  reason: string | null;
  language: string | null;
  priority: string | null;
  rawResponse: unknown;
};

/**
 * Decides whether an incoming email is a transport-order request before the
 * pipeline creates a TransportOrder. It is deliberately resilient: any problem
 * (disabled, not configured, network/timeout, undecidable response) returns
 * `null` so the caller can fall back to the previous behavior and NEVER drop a
 * real email because of the classifier.
 */
@Injectable()
export class AiClassificationService {
  private readonly logger = new Logger(AiClassificationService.name);

  constructor(private readonly configService: ConfigService) {}

  private boolEnv(name: string, defaultValue: boolean) {
    const raw = (this.configService.get<string>(name) ?? '').trim();
    if (!raw) return defaultValue;
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  isEnabled() {
    return this.boolEnv('AUTO_AI_CLASSIFICATION_ENABLED', true);
  }

  private resolveApiUrl() {
    const rawBase = (
      this.configService.get<string>('AI_API_BASE_URL') || ''
    ).trim();
    if (!rawBase) return '';

    const rawPath =
      (this.configService.get<string>('AI_CLASSIFICATION_API_URL') || '').trim() ||
      '/classify-email';

    const normalizeBase = (b: string) => b.replace(/\/+$/, '');
    const normalizePath = (p: string) => (p.startsWith('/') ? p : `/${p}`);
    return `${normalizeBase(rawBase)}${normalizePath(rawPath)}`;
  }

  private getApiKey() {
    return (this.configService.get<string>('AI_API_KEY') || '').trim();
  }

  private extractClassification(raw: unknown): AiClassificationResult | null {
    if (!raw || typeof raw !== 'object') return null;

    // Accept the result either at the top level or wrapped under data/result.
    const candidates: any[] = [
      raw,
      (raw as any).data,
      (raw as any).result,
      (raw as any).classification,
    ].filter((c) => c && typeof c === 'object');

    for (const candidate of candidates) {
      const value = candidate.isTransportOrder;
      const isTransportOrder =
        typeof value === 'boolean'
          ? value
          : typeof value === 'string'
            ? value.trim().toLowerCase() === 'true'
            : null;

      if (isTransportOrder === null) continue;

      const str = (v: unknown) =>
        typeof v === 'string' && v.trim() ? v.trim() : null;

      return {
        isTransportOrder,
        reason: str(candidate.reason),
        language: str(candidate.language),
        priority: str(candidate.priority),
        rawResponse: raw,
      };
    }

    return null;
  }

  async classify(
    payload: AiClassificationPayload,
  ): Promise<AiClassificationResult | null> {
    if (!this.isEnabled()) {
      this.logger.log(
        `AI classification disabled (AUTO_AI_CLASSIFICATION_ENABLED=false) emailId=${payload.emailId}`,
      );
      return null;
    }

    const url = this.resolveApiUrl();
    if (!url) {
      this.logger.warn(
        `AI_API_BASE_URL not configured; skipping AI classification emailId=${payload.emailId}`,
      );
      return null;
    }

    try {
      try {
        // eslint-disable-next-line no-new
        new URL(url);
      } catch {
        this.logger.warn(
          `AI classification URL is invalid; skipping. Got: ${url}`,
        );
        return null;
      }

      const apiKey = this.getApiKey();
      const timeoutMs = Number(
        this.configService.get<string>('AI_CLASSIFICATION_TIMEOUT_MS') ||
          '60000',
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const contentType = res.headers.get('content-type') || '';
      const raw = contentType.includes('application/json')
        ? await res.json()
        : { raw: await res.text() };

      if (!res.ok) {
        this.logger.warn(
          `AI classification API error: status=${res.status} url=${url} emailId=${payload.emailId}`,
        );
        return null;
      }

      const result = this.extractClassification(raw);
      if (!result) {
        this.logger.warn(
          `AI classification returned an undecidable response emailId=${payload.emailId}`,
        );
        return null;
      }

      return result;
    } catch (err: any) {
      this.logger.warn(
        `AI classification request failed for emailId=${payload.emailId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }
}
