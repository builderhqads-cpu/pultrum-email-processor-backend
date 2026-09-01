import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type DoclingExtractInput = {
  fileName: string;
  mimeType?: string | null;
  contentBase64: string;
};

/**
 * Client for the docling document-extraction microservice (PDF/DOCX/XLSX ->
 * structured text). Best-effort by design: any failure (disabled, unreachable,
 * unsupported file, timeout) returns null so the caller falls back to the current
 * behaviour and the pipeline is never blocked by extraction.
 */
@Injectable()
export class DoclingService {
  private readonly logger = new Logger(DoclingService.name);

  constructor(private readonly configService: ConfigService) {}

  get enabled(): boolean {
    const raw = (this.configService.get<string>('DOCLING_ENABLED') ?? '').trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  private get baseUrl(): string {
    return (
      this.configService.get<string>('DOCLING_URL') || 'http://localhost:8000'
    ).replace(/\/+$/, '');
  }

  private get timeoutMs(): number {
    const n = Number(
      this.configService.get<string>('DOCLING_TIMEOUT_MS') || '120000',
    );
    return Number.isFinite(n) && n > 0 ? n : 120000;
  }

  /**
   * Extract structured text (Markdown) from an attachment. Returns the text, or
   * null on any failure — the caller must treat null as "no extraction, fall
   * back".
   */
  async extractText(input: DoclingExtractInput): Promise<string | null> {
    if (!this.enabled) return null;
    if (!input?.contentBase64?.trim()) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/extract-base64`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: input.fileName,
          contentBase64: input.contentBase64,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `docling extract failed status=${res.status} file=${input.fileName} body=${body.slice(0, 200)}`,
        );
        return null;
      }
      const data = (await res.json()) as { text?: string };
      const text = (data?.text ?? '').trim();
      return text || null;
    } catch (err: any) {
      this.logger.warn(
        `docling unreachable (${err?.message ?? err}); falling back file=${input.fileName}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
