import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OcrExtractInput, OcrExtractOutput, OcrProviderName } from './ocr.interfaces';
import { OpenRouterOcrService } from './openrouter-ocr.service';

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly openRouterOcrService: OpenRouterOcrService,
  ) {}

  isEnabled() {
    const raw = (this.configService.get<string>('OCR_ENABLED') ?? '').trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  /**
   * Image (computer-vision) OCR is gated separately and OFF by default.
   * Photos cost ~4x the tokens, so for now images are attached but NOT
   * processed. Flip IMAGE_OCR_ENABLED=true to re-enable vision OCR.
   */
  imageOcrEnabled() {
    const raw = (
      this.configService.get<string>('IMAGE_OCR_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  private getProvider(): OcrProviderName {
    const raw = (this.configService.get<string>('OCR_PROVIDER') || 'openrouter')
      .trim()
      .toLowerCase();
    if (raw === 'azure-document-intelligence') return 'azure-document-intelligence';
    if (raw === 'google-document-ai') return 'google-document-ai';
    if (raw === 'tesseract') return 'tesseract';
    return 'openrouter';
  }

  async extractTextFromPdf(input: OcrExtractInput): Promise<OcrExtractOutput | null> {
    const provider = this.getProvider();

    if (provider === 'openrouter') {
      const text = await this.openRouterOcrService.ocrPdf(input);
      if (text && text.trim()) {
        return {
          text,
          provider: 'openrouter',
          method: 'OPENROUTER_MISTRAL_OCR',
        };
      }
      return null;
    }

    this.logger.log(
      `OCR provider not implemented yet (provider=${provider}). Skipping real OCR.`,
    );
    return null;
  }

  async extractTextFromImage(
    input: OcrExtractInput,
  ): Promise<OcrExtractOutput | null> {
    const provider = this.getProvider();

    if (provider === 'openrouter') {
      const text = await this.openRouterOcrService.ocrImage(input);
      if (text && text.trim()) {
        return {
          text,
          provider: 'openrouter',
          method: 'OPENROUTER_VISION_OCR',
        };
      }
      return null;
    }

    this.logger.log(
      `Image OCR provider not implemented yet (provider=${provider}). Skipping.`,
    );
    return null;
  }
}

