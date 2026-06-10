import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OcrExtractInput } from './ocr.interfaces';

/**
 * OCR for scanned PDFs via OpenRouter's file-parser plugin (mistral-ocr engine).
 * Reuses the same OPENROUTER_API_KEY as the other AI features. Best-effort: any
 * failure returns null so the pipeline keeps its safe OCR_REQUIRED/FAILED state.
 */
@Injectable()
export class OpenRouterOcrService {
  private readonly logger = new Logger(OpenRouterOcrService.name);

  constructor(private readonly configService: ConfigService) {}

  async ocrPdf(input: OcrExtractInput): Promise<string | null> {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not configured; skipping OCR');
      return null;
    }

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
        return content.trim();
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
}
