import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OcrExtractInput } from './ocr.interfaces';

/**
 * OCR via OpenRouter. Scanned PDFs use the file-parser plugin (mistral-ocr);
 * images use the vision model directly. Reuses OPENROUTER_API_KEY. Best-effort:
 * any failure returns null so the pipeline keeps its safe FAILED/OCR_REQUIRED state.
 */
@Injectable()
export class OpenRouterOcrService {
  private readonly logger = new Logger(OpenRouterOcrService.name);

  constructor(private readonly configService: ConfigService) {}

  private config() {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    const model = (
      this.configService.get<string>('OCR_OPENROUTER_MODEL') ||
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'openai/gpt-4o-mini'
    ).trim();
    const timeoutMs = Number(
      this.configService.get<string>('OCR_OPENROUTER_TIMEOUT_MS') ||
        this.configService.get<string>('OPENROUTER_TIMEOUT_MS') ||
        '120000',
    );
    return { apiKey, model, timeoutMs };
  }

  // The vision model sometimes returns an apology/refusal ("I'm sorry, but I
  // can't extract text from images.") instead of text. Treat those as no-text
  // so they don't pollute the extracted content.
  private looksLikeRefusal(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t) return true;
    if (t.length > 400) return false; // long output is real extracted text
    const refusal =
      /(i'?m sorry|i am sorry|i cannot|i can'?t|i can not|i'?m not able|i am not able|unable to|as an ai|i'?m unable)/;
    const topic = /(extract|text|image|read|assist|help|process|provide)/;
    return refusal.test(t) && topic.test(t);
  }

  private async chat(
    requestBody: unknown,
    fileName: string,
    timeoutMs: number,
    apiKey: string,
  ): Promise<string | null> {
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
        this.logger.warn(
          `OpenRouter OCR failed: status=${res.status} fileName=${fileName}`,
        );
        return null;
      }

      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        const text = content.trim();
        if (this.looksLikeRefusal(text)) {
          this.logger.warn(
            `OpenRouter OCR refused/no-text fileName=${fileName}`,
          );
          return null;
        }
        return text;
      }

      this.logger.warn(`OpenRouter OCR returned no text fileName=${fileName}`);
      return null;
    } catch (err: any) {
      this.logger.warn(
        `OpenRouter OCR request failed fileName=${fileName}: ${err?.message ?? err}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ocrPdf(input: OcrExtractInput): Promise<string | null> {
    const { apiKey, model, timeoutMs } = this.config();
    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not configured; skipping OCR');
      return null;
    }

    const mimeType = (input.mimeType || 'application/pdf').trim();
    const fileName = (input.fileName || 'document.pdf').trim();
    const dataUrl = `data:${mimeType};base64,${input.buffer.toString('base64')}`;

    const requestBody = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract and return ALL text from this document verbatim, preserving line breaks and field labels. Do not summarize, translate, comment, or add anything — return only the document text.',
            },
            {
              type: 'file',
              file: { filename: fileName, file_data: dataUrl },
            },
          ],
        },
      ],
      // file-parser plugin with the OCR engine for scanned PDFs.
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      temperature: 0,
      stream: false,
    };

    return this.chat(requestBody, fileName, timeoutMs, apiKey);
  }

  async ocrImage(input: OcrExtractInput): Promise<string | null> {
    const { apiKey, model, timeoutMs } = this.config();
    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not configured; skipping OCR');
      return null;
    }

    const mimeType = (input.mimeType || 'image/png').trim();
    const fileName = (input.fileName || 'image.png').trim();
    const dataUrl = `data:${mimeType};base64,${input.buffer.toString('base64')}`;

    const requestBody = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are an OCR engine. Transcribe the literal text present in this image, preserving line breaks and labels. Do not describe the image, do not comment, do not apologize or refuse. Return only the transcribed text; if there is no readable text, return nothing at all.',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      temperature: 0,
      stream: false,
    };

    return this.chat(requestBody, fileName, timeoutMs, apiKey);
  }
}
