import * as xlsx from 'xlsx';
import { AttachmentExtractionStatus } from '@prisma/client';
import { OcrService } from '../ocr/ocr.service';

describe('AttachmentExtractionService', () => {
  it('extracts text from TXT and CSV', async () => {
    const {
      AttachmentExtractionService,
    } = require('./attachment-extraction.service');
    const service = new AttachmentExtractionService({
      isEnabled: () => false,
      extractTextFromPdf: async () => null,
    } as unknown as OcrService);

    const txt = await service.extractFromBase64({
      fileName: 'note.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Hello world\nLine 2', 'utf8').toString(
        'base64',
      ),
    });
    expect(txt.extractionStatus).toBe(AttachmentExtractionStatus.SUCCESS);
    expect(txt.extractionMethod).toBe('TXT_UTF8');
    expect(txt.extractedText).toBe('Hello world\nLine 2');

    const csv = await service.extractFromBase64({
      fileName: 'data.csv',
      mimeType: 'text/csv',
      contentBase64: Buffer.from('a,b\n1,2', 'utf8').toString('base64'),
    });
    expect(csv.extractionStatus).toBe(AttachmentExtractionStatus.SUCCESS);
    expect(csv.extractionMethod).toBe('CSV_UTF8');
    expect(csv.extractedText).toBe('a: 1\nb: 2');
  });

  it('extracts text from XLSX using xlsx->csv', async () => {
    const {
      AttachmentExtractionService,
    } = require('./attachment-extraction.service');
    const service = new AttachmentExtractionService({
      isEnabled: () => false,
      extractTextFromPdf: async () => null,
    } as unknown as OcrService);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([
      ['colA', 'colB'],
      ['1', '2'],
    ]);
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = xlsx.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;

    const res = await service.extractFromBase64({
      fileName: 'data.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
    });

    expect(res.extractionStatus).toBe(AttachmentExtractionStatus.SUCCESS);
    expect(res.extractionMethod).toBe('XLSX_TO_CSV');
    expect(res.extractedText).toContain('Sheet: Sheet1');
    expect(res.extractedText).toContain('colA: 1');
    expect(res.extractedText).toContain('colB: 2');
  });

  it('marks OCR_REQUIRED when PDF has no embedded text and OCR is disabled', async () => {
    jest.resetModules();
    jest.doMock('pdf-parse', () => async () => ({ text: '' }));

    const {
      AttachmentExtractionService,
    } = require('./attachment-extraction.service');
    const service = new AttachmentExtractionService({
      isEnabled: () => false,
      extractTextFromPdf: async () => null,
    } as unknown as OcrService);

    const res = await service.extractFromBase64({
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('fake-pdf', 'utf8').toString('base64'),
    });

    expect(res.extractionStatus).toBe(AttachmentExtractionStatus.OCR_REQUIRED);
    expect(res.extractionMethod).toBe('PDF_PARSE_NO_TEXT');
    expect(res.extractedText).toBeNull();
  });

  it('marks OCR_REQUIRED when PDF parsing fails and OCR is disabled', async () => {
    jest.resetModules();
    jest.doMock('pdf-parse', () => async () => {
      throw new Error('bad XRef entry');
    });

    const {
      AttachmentExtractionService,
    } = require('./attachment-extraction.service');
    const service = new AttachmentExtractionService({
      isEnabled: () => false,
      extractTextFromPdf: async () => null,
    } as unknown as OcrService);

    const res = await service.extractFromBase64({
      fileName: 'broken.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('fake-pdf', 'utf8').toString('base64'),
    });

    expect(res.extractionStatus).toBe(AttachmentExtractionStatus.OCR_REQUIRED);
    expect(res.extractionMethod).toBe('PDF_PARSE_ERROR_OCR_REQUIRED');
    expect(res.extractedText).toBeNull();
  });

  it('falls back to OCR when PDF parsing fails and OCR is enabled', async () => {
    jest.resetModules();
    jest.doMock('pdf-parse', () => async () => {
      throw new Error('bad XRef entry');
    });

    const {
      AttachmentExtractionService,
    } = require('./attachment-extraction.service');
    const service = new AttachmentExtractionService({
      isEnabled: () => true,
      extractTextFromPdf: async () => ({
        text: 'Pickup time: 10:00',
        method: 'OCR_TEST',
      }),
    } as unknown as OcrService);

    const res = await service.extractFromBase64({
      fileName: 'broken.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('fake-pdf', 'utf8').toString('base64'),
    });

    expect(res.extractionStatus).toBe(AttachmentExtractionStatus.SUCCESS);
    expect(res.extractionMethod).toBe('OCR_TEST');
    expect(res.extractedText).toBe('Pickup time: 10:00');
  });
});
