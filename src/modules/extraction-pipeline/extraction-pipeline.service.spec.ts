import { OrderStatus } from '@prisma/client';
import { ExtractionPipelineService } from './extraction-pipeline.service';

describe('ExtractionPipelineService', () => {
  it('builds combinedText with sanitized HTML and attachment text', async () => {
    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          emailMessageId: 'email-1',
          emailMessage: {
            attachments: [
              { id: 'att-1', fileName: 'a.txt', extractedText: null },
              { id: 'att-2', fileName: 'b.txt', extractedText: 'Already extracted' },
            ],
          },
        }),
        update: jest.fn(),
      },
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'email-1',
          subject: 'Hello',
          bodyText: 'Body text',
          bodyHtml: '<div>Hi<br>there</div>',
          attachments: [
            { fileName: 'a.txt', extractedText: 'From attachment' },
            { fileName: 'b.txt', extractedText: 'Already extracted' },
          ],
        }),
      },
    };

    const attachmentParserService: any = {
      extractTextFromAttachment: jest
        .fn()
        .mockResolvedValueOnce('From attachment')
        .mockImplementationOnce(() => {
          throw new Error('fail');
        }),
    };

    const labelParserService: any = { extract: jest.fn().mockReturnValue([]) };
    const regexExtractionService: any = { extract: jest.fn().mockReturnValue([]) };
    const fieldMergeService: any = { merge: jest.fn().mockReturnValue([]) };
    const transportBookingValidationService: any = {
      validateOrderFromFieldValues: jest.fn().mockResolvedValue({
        detectedFields: [],
        missingFields: [],
        isComplete: true,
        overallConfidence: 1,
      }),
    };

    const service = new ExtractionPipelineService(
      prismaService,
      attachmentParserService,
      labelParserService,
      regexExtractionService,
      { extract: jest.fn().mockResolvedValue(null) },
      fieldMergeService,
      transportBookingValidationService,
    );

    const result = await service.runForOrder('order-1');

    expect(result.combinedText).toContain('Subject:\nHello');
    expect(result.combinedText).toContain('BodyText:\nBody text');
    expect(result.combinedText).toContain('BodyHtml:\nHi there');
    expect(result.combinedText).toContain('AttachmentFileName: a.txt');
    expect(result.combinedText).toContain('AttachmentExtractedText:\nFrom attachment');
  });

  it('sets order status to MISSING_INFORMATION when validation is incomplete', async () => {
    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          emailMessageId: 'email-1',
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

    const transportBookingValidationService: any = {
      validateOrderFromFieldValues: jest.fn().mockResolvedValue({
        detectedFields: [],
        missingFields: [{ key: 'pickup_date', label: 'Pickup date', reason: 'missing' }],
        isComplete: false,
        overallConfidence: 0.1,
      }),
    };

    const service = new ExtractionPipelineService(
      prismaService,
      attachmentParserService,
      labelParserService,
      regexExtractionService,
      { extract: jest.fn().mockResolvedValue(null) },
      fieldMergeService,
      transportBookingValidationService,
    );

    await service.runForOrder('order-1');

    expect(prismaService.transportOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: OrderStatus.MISSING_INFORMATION }),
      }),
    );
  });
});
