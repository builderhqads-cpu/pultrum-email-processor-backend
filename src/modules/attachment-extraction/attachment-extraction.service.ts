import { Injectable, Logger } from '@nestjs/common';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import JSZip from 'jszip';
import { AttachmentExtractionStatus } from '@prisma/client';
import { OcrService } from '../ocr/ocr.service';

export type AttachmentExtractionResult = {
  extractedText: string | null;
  extractionMethod: string | null;
  extractionStatus: AttachmentExtractionStatus;
};

type DetectInput = { mimeType?: string | null; fileName?: string | null };

const normalizeText = (text: string) =>
  (text ?? '')
    .toString()
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

/**
 * Custom pdf-parse page renderer that preserves layout: inserts a space on a
 * horizontal gap between text runs (e.g. table columns) and a newline on a line
 * change. The default renderer concatenates same-line runs without a space,
 * gluing labels to values ("Leverdatum12-06-2026").
 */
async function renderPdfPage(pageData: any): Promise<string> {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: true,
    disableCombineTextItems: false,
  });
  let text = '';
  let lastY: number | undefined;
  let lastXEnd: number | undefined;
  for (const item of (textContent.items ?? []) as Array<any>) {
    const str = (item?.str ?? '').toString();
    const x = item?.transform?.[4] ?? 0;
    const y = item?.transform?.[5] ?? 0;
    const width = item?.width ?? 0;

    if (lastY !== undefined && Math.abs(y - lastY) > 2) {
      if (!text.endsWith('\n')) text += '\n';
      lastXEnd = undefined;
    } else if (
      lastXEnd !== undefined &&
      x - lastXEnd > 1 &&
      !text.endsWith(' ') &&
      !text.endsWith('\n')
    ) {
      text += ' ';
    }

    text += str;
    lastY = y;
    lastXEnd = x + width;
  }
  return text;
}

@Injectable()
export class AttachmentExtractionService {
  private readonly logger = new Logger(AttachmentExtractionService.name);

  constructor(private readonly ocrService: OcrService) {}

  private async handlePdfOcrFallback(input: {
    attachmentId?: string;
    fileName?: string | null;
    mimeType?: string | null;
    buffer: Buffer;
    reason: 'no_text' | 'parse_error';
  }): Promise<AttachmentExtractionResult> {
    if (this.ocrService.isEnabled()) {
      const ocr = await this.ocrService.extractTextFromPdf({
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        buffer: input.buffer,
      });

      if (ocr?.text?.trim()) {
        return {
          extractedText: this.normalizeExtractedText(ocr.text),
          extractionMethod: ocr.method,
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      return {
        extractedText: null,
        extractionMethod: 'OCR_NO_TEXT',
        extractionStatus: AttachmentExtractionStatus.FAILED,
      };
    }

    const reasonCode =
      input.reason === 'parse_error'
        ? 'PDF_PARSE_ERROR_OCR_REQUIRED'
        : 'PDF_PARSE_NO_TEXT';

    this.logger.log(
      `PDF requires OCR (OCR_ENABLED=false) attachmentId=${input.attachmentId ?? 'n/a'} fileName=${input.fileName ?? 'n/a'} reason=${input.reason}`,
    );

    return {
      extractedText: null,
      extractionMethod: reasonCode,
      extractionStatus: AttachmentExtractionStatus.OCR_REQUIRED,
    };
  }

  private decodeHtmlEntitiesKeepNewlines(input: string) {
    // Minimal decoding to remove escaped HTML fragments from attachment text.
    return (input || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, num) => {
        const codePoint = Number.parseInt(num, 10);
        if (!Number.isFinite(codePoint)) return _;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return _;
        }
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        if (!Number.isFinite(codePoint)) return _;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return _;
        }
      });
  }

  private sanitizeAttachmentText(text: string) {
    let out = this.decodeHtmlEntitiesKeepNewlines(text ?? '');

    // Convert common breaks to newlines, strip containers but keep separation.
    out = out
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*(div|p|li|tr|td|th)\s*>/gi, '\n')
      .replace(/<\s*(div|p|li|tr|td|th)(\s+[^>]*)?>/gi, '');

    // Strip remaining tags.
    out = out.replace(/<[^>]*>/g, '');

    // Normalize newlines, collapse horizontal whitespace, and tidy lines.
    out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    out = out.replace(/[ \t\f\v]+/g, ' ');
    out = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join('\n');

    return out.trim();
  }

  private tableToLabelLines(rows: unknown[][]) {
    if (!Array.isArray(rows) || rows.length < 2) return '';
    const headerRow = rows[0] ?? [];
    const dataRows = rows.slice(1);

    const headers = headerRow.map((h) => (h == null ? '' : String(h)).trim());
    if (!headers.length) return '';

    const blocks: string[] = [];
    for (const row of dataRows) {
      if (!Array.isArray(row)) continue;
      const lines: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        const label = headers[i];
        if (!label) continue;
        const value = row[i] == null ? '' : String(row[i]).trim();
        if (!value) continue;
        lines.push(`${label}: ${value}`);
      }
      if (lines.length) blocks.push(lines.join('\n'));
    }

    return blocks.join('\n\n');
  }

  private detectKind(input: DetectInput) {
    const mime = (input.mimeType || '').trim().toLowerCase();
    const name = (input.fileName || '').trim().toLowerCase();

    if (mime.startsWith('text/plain') || name.endsWith('.txt')) return 'txt';
    if (mime.startsWith('text/csv') || name.endsWith('.csv')) return 'csv';
    if (mime.startsWith('application/pdf') || name.endsWith('.pdf'))
      return 'pdf';

    if (
      mime.includes('spreadsheetml') ||
      mime === 'application/vnd.ms-excel' ||
      name.endsWith('.xlsx') ||
      name.endsWith('.xls')
    ) {
      return 'excel';
    }

    if (
      mime.includes('wordprocessingml') ||
      mime === 'application/msword' ||
      name.endsWith('.docx')
    ) {
      return 'docx';
    }

    if (
      mime.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)
    ) {
      return 'image';
    }

    return 'unknown';
  }

  private async handleImageOcr(input: {
    attachmentId?: string;
    fileName?: string | null;
    mimeType?: string | null;
    buffer: Buffer;
  }): Promise<AttachmentExtractionResult> {
    if (this.ocrService.isEnabled()) {
      const ocr = await this.ocrService.extractTextFromImage({
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        buffer: input.buffer,
      });

      if (ocr?.text?.trim()) {
        return {
          extractedText: this.normalizeExtractedText(ocr.text),
          extractionMethod: ocr.method,
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      return {
        extractedText: null,
        extractionMethod: 'OCR_NO_TEXT',
        extractionStatus: AttachmentExtractionStatus.FAILED,
      };
    }

    this.logger.log(
      `Image requires OCR (OCR_ENABLED=false) attachmentId=${input.attachmentId ?? 'n/a'} fileName=${input.fileName ?? 'n/a'}`,
    );

    return {
      extractedText: null,
      extractionMethod: 'IMAGE_OCR_REQUIRED',
      extractionStatus: AttachmentExtractionStatus.OCR_REQUIRED,
    };
  }

  private guessImageMime(name: string): string {
    const n = (name || '').toLowerCase();
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.bmp')) return 'image/bmp';
    if (n.endsWith('.tif') || n.endsWith('.tiff')) return 'image/tiff';
    return 'image/png';
  }

  // OCR images embedded inside a DOCX (word/media/*) so data that lives only in
  // an image isn't lost. Skips tiny images (icons) and caps the count to bound cost.
  private async extractDocxImageText(buffer: Buffer): Promise<string> {
    if (!this.ocrService.isEnabled()) return '';
    try {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files).filter(
        (f) =>
          !f.dir &&
          /^word\/media\//i.test(f.name) &&
          /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f.name),
      );
      if (!entries.length) return '';

      const texts: string[] = [];
      let processed = 0;
      for (const entry of entries) {
        if (processed >= 8) break;
        const imgBuffer = (await entry.async('nodebuffer')) as Buffer;
        if (imgBuffer.length < 8 * 1024) continue; // skip icons/decorations
        processed++;
        const ocr = await this.ocrService.extractTextFromImage({
          fileName: entry.name,
          mimeType: this.guessImageMime(entry.name),
          buffer: imgBuffer,
        });
        if (ocr?.text?.trim()) texts.push(ocr.text.trim());
      }
      return texts.join('\n\n');
    } catch (err: any) {
      this.logger.warn(
        `DOCX embedded-image OCR failed: ${err?.message ?? err}`,
      );
      return '';
    }
  }

  private normalizeExtractedText(text: string | null) {
    if (!text) return null;
    const normalized = normalizeText(text);
    if (!normalized) return null;
    // For attachments we want to keep line breaks so deterministic label parsing works.
    return this.sanitizeAttachmentText(normalized);
  }

  async extractFromBase64(input: {
    attachmentId?: string;
    fileName?: string | null;
    mimeType?: string | null;
    contentBase64?: string | null;
  }): Promise<AttachmentExtractionResult> {
    if (!input.contentBase64) {
      return {
        extractedText: null,
        extractionMethod: null,
        extractionStatus: AttachmentExtractionStatus.FAILED,
      };
    }

    const buffer = Buffer.from(input.contentBase64, 'base64');
    const kind = this.detectKind(input);

    try {
      if (kind === 'txt') {
        const text = buffer.toString('utf8');
        return {
          extractedText: this.normalizeExtractedText(text),
          extractionMethod: 'TXT_UTF8',
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      if (kind === 'csv') {
        const text = buffer.toString('utf8');
        // Convert simple table CSV into label:value lines when possible.
        let labeled = '';
        try {
          const wb = xlsx.read(text, { type: 'string' });
          const first = wb.SheetNames?.[0];
          const sheet = first ? wb.Sheets?.[first] : undefined;
          const rows = sheet
            ? (xlsx.utils.sheet_to_json(sheet, {
                header: 1,
                raw: false,
                defval: '',
              }) as unknown[][])
            : [];
          labeled = this.tableToLabelLines(rows);
        } catch {
          labeled = '';
        }
        return {
          extractedText: this.normalizeExtractedText(labeled || text),
          extractionMethod: 'CSV_UTF8',
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      if (kind === 'pdf') {
        try {
          const result = await pdfParse(buffer, {
            pagerender: renderPdfPage,
          } as any);
          const extracted = this.normalizeExtractedText(result?.text || '');

          if (!extracted) {
            return this.handlePdfOcrFallback({
              attachmentId: input.attachmentId,
              fileName: input.fileName,
              mimeType: input.mimeType,
              buffer,
              reason: 'no_text',
            });
          }

          return {
            extractedText: extracted,
            extractionMethod: 'PDF_PARSE',
            extractionStatus: AttachmentExtractionStatus.SUCCESS,
          };
        } catch (err: any) {
          this.logger.warn(
            `PDF parse failed attachmentId=${input.attachmentId ?? 'n/a'} fileName=${input.fileName ?? 'n/a'}: ${err?.message ?? err}`,
          );

          return this.handlePdfOcrFallback({
            attachmentId: input.attachmentId,
            fileName: input.fileName,
            mimeType: input.mimeType,
            buffer,
            reason: 'parse_error',
          });
        }
      }

      if (kind === 'excel') {
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const parts: string[] = [];
        for (const sheetName of workbook.SheetNames || []) {
          const sheet = workbook.Sheets?.[sheetName];
          if (!sheet) continue;
          const rows = xlsx.utils.sheet_to_json(sheet, {
            header: 1,
            raw: false,
            defval: '',
          }) as unknown[][];
          const labeled = this.tableToLabelLines(rows);
          const fallbackCsv = xlsx.utils.sheet_to_csv(sheet);
          const content = labeled || normalizeText(fallbackCsv);
          if (!content) continue;
          parts.push(`Sheet: ${sheetName}\n${content}`);
        }

        return {
          extractedText: this.normalizeExtractedText(parts.join('\n\n')),
          extractionMethod: 'XLSX_TO_CSV',
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      if (kind === 'docx') {
        const result = await mammoth.extractRawText({ buffer });
        const docText = this.normalizeExtractedText(result?.value || '') || '';

        // OCR embedded images ONLY when the document text is sparse (an
        // image-heavy doc). For text-rich docs the images are usually logos or
        // maps, so OCR'ing them just adds noise (e.g. street names).
        const rawImageText =
          docText.length < 300 ? await this.extractDocxImageText(buffer) : '';
        const imageText = rawImageText
          ? this.normalizeExtractedText(rawImageText)
          : null;

        const parts = [docText];
        if (imageText) {
          parts.push(`[Afbeeldingen / image text]\n${imageText}`);
        }
        const combined = parts.filter((p) => p && p.trim()).join('\n\n');

        return {
          extractedText: combined || null,
          extractionMethod: imageText
            ? 'MAMMOTH_RAW_TEXT+IMAGE_OCR'
            : 'MAMMOTH_RAW_TEXT',
          extractionStatus: AttachmentExtractionStatus.SUCCESS,
        };
      }

      if (kind === 'image') {
        return this.handleImageOcr({
          attachmentId: input.attachmentId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          buffer,
        });
      }

      return {
        extractedText: null,
        extractionMethod: 'UNSUPPORTED',
        extractionStatus: AttachmentExtractionStatus.FAILED,
      };
    } catch (err: any) {
      this.logger.warn(
        `Attachment extraction failed attachmentId=${input.attachmentId ?? 'n/a'} fileName=${input.fileName ?? 'n/a'}: ${err?.message ?? err}`,
      );
      return {
        extractedText: null,
        extractionMethod: kind.toUpperCase(),
        extractionStatus: AttachmentExtractionStatus.FAILED,
      };
    }
  }
}
