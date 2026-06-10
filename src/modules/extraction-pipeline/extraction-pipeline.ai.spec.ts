import { OrderStatus } from '@prisma/client';
import { ExtractionPipelineService } from './extraction-pipeline.service';

describe('ExtractionPipelineService (AI extraction fallback)', () => {
  it('calls AI extraction when missingFields > 5 and revalidates', async () => {
    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          emailMessageId: 'email-1',
          department: 'OPEN_TRANSPORT',
          emailMessage: { attachments: [] },
        }),
        update: jest.fn(),
      },
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'email-1',
          subject: 'S',
          bodyText: 'T',
          bodyHtml: null,
          attachments: [],
        }),
      },
    };

    const attachmentParserService: any = { extractTextFromAttachment: jest.fn() };
    const labelParserService: any = { extract: jest.fn().mockReturnValue([]) };
    const regexExtractionService: any = { extract: jest.fn().mockReturnValue([]) };
    const fieldMergeService: any = { merge: jest.fn().mockReturnValue([]) };

    const aiExtractionService: any = {
      extract: jest.fn().mockResolvedValue({
        fields: { pickup_date: '2026-06-01' },
        rawResponse: { ok: true },
      }),
    };

    const transportBookingValidationService: any = {
      validateOrderFromFieldValues: jest
        .fn()
        // first deterministic validation: many missing fields
        .mockResolvedValueOnce({
          detectedFields: [],
          missingFields: Array.from({ length: 6 }).map((_, i) => ({
            key: `m${i}`,
            label: `M${i}`,
            reason: 'missing',
          })),
          isComplete: false,
          overallConfidence: 0.5,
        })
        // second validation after AI merge: complete
        .mockResolvedValueOnce({
          detectedFields: [],
          missingFields: [],
          isComplete: true,
          overallConfidence: 0.9,
        }),
    };

    const service = new ExtractionPipelineService(
      prismaService,
      attachmentParserService,
      labelParserService,
      regexExtractionService,
      aiExtractionService,
      fieldMergeService,
      transportBookingValidationService,
    );

    const res = await service.runForOrder('order-1');

    expect(aiExtractionService.extract).toHaveBeenCalled();
    expect(res.aiUsed).toBe(true);
    expect(prismaService.transportOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.READY_TO_XML }),
      }),
    );
  });

  it('does not send technical generated fields to AI extraction', async () => {
    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          emailMessageId: 'email-1',
          department: 'OPEN_TRANSPORT',
          emailMessage: { attachments: [] },
        }),
        update: jest.fn(),
      },
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'email-1',
          subject: 'S',
          bodyText: 'T',
          bodyHtml: null,
          attachments: [],
        }),
      },
    };

    const attachmentParserService: any = { extractTextFromAttachment: jest.fn() };
    const labelParserService: any = { extract: jest.fn().mockReturnValue([]) };
    const regexExtractionService: any = { extract: jest.fn().mockReturnValue([]) };

    const fieldMergeService: any = {
      merge: jest.fn().mockReturnValue([
        { key: 'edireference', value: 'EDI-123', confidence: 1, source: 'GENERATED' },
        { key: 'barcode', value: 'BC-1', confidence: 1, source: 'GENERATED' },
        { key: 'pickup_date', value: '2026-06-01', confidence: 0.95, source: 'EMAIL' },
      ]),
    };

    const aiExtractionService: any = {
      extract: jest.fn().mockResolvedValue(null),
    };

    const transportBookingValidationService: any = {
      validateOrderFromFieldValues: jest.fn().mockResolvedValue({
        detectedFields: [],
        missingFields: [{ key: 'delivery_country', label: 'Delivery country', reason: 'missing' }],
        isComplete: false,
        overallConfidence: 0.5,
      }),
    };

    const service = new ExtractionPipelineService(
      prismaService,
      attachmentParserService,
      labelParserService,
      regexExtractionService,
      aiExtractionService,
      fieldMergeService,
      transportBookingValidationService,
    );

    await service.runForOrder('order-1', { forceAiExtraction: true });

    const payload = aiExtractionService.extract.mock.calls[0]?.[0];
    expect(payload.detectedFields.some((f: any) => f.key === 'edireference')).toBe(false);
    expect(payload.detectedFields.some((f: any) => f.key === 'barcode')).toBe(false);
    expect(payload.detectedFields.some((f: any) => f.key === 'pickup_date')).toBe(true);
  });
});
