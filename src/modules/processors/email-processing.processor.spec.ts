import { FieldMergeService } from '../field-merge/field-merge.service';
import { EmailProcessingProcessor } from './email-processing.processor';

describe('EmailProcessingProcessor (reply linking)', () => {
  it('merges previous order fields with the latest reply instead of replacing them', async () => {
    const prismaService: any = {
      emailMessage: {
        update: jest.fn(async () => ({})),
        findMany: jest.fn(async () => [
          {
            id: 'reply-1',
            subject: 'RE: Order 001',
            bodyText: 'Reply body',
            bodyHtml: null,
            receivedAt: new Date('2026-06-02T00:00:00Z'),
            attachments: [],
          },
        ]),
      },
      $transaction: jest.fn(async (fn: any) => fn(prismaService)),
      xmlDelivery: { deleteMany: jest.fn(async () => ({})) },
      transportOrder: {
        update: jest.fn(async () => ({})),
      },
      aiRequest: { create: jest.fn(async () => ({})) },
    };

    const requiredFieldsService: any = {
      validateEmailContent: jest.fn(async () => ({
        detectedFields: [
          {
            key: 'delivery_city',
            label: 'Delivery city',
            value: 'Hanau',
            confidence: 0.95,
          },
        ],
        missingFields: [],
        overallConfidence: 0.9,
      })),
    };

    const auditLogService: any = { log: jest.fn(async () => ({})) };
    const graphService: any = {};
    const attachmentParserService: any = {};
    const orderClassifierService: any = {};
    const threadLinkingService: any = {};
    const emailContextMapperService: any = {};
    const aiExtractionService: any = { extract: jest.fn(async () => null) };
    const transportBookingValidationService: any = {
      validateOrderFromFieldValues: jest.fn(async () => ({
        missingFields: [],
      })),
    };

    const processor = new EmailProcessingProcessor(
      prismaService,
      requiredFieldsService,
      auditLogService,
      graphService,
      attachmentParserService,
      orderClassifierService,
      threadLinkingService,
      emailContextMapperService,
      aiExtractionService,
      transportBookingValidationService,
      new FieldMergeService(),
      { classify: jest.fn(async () => null) } as any,
    );

    const existingOrder: any = {
      id: 'order-1',
      status: 'WAITING_CUSTOMER_RESPONSE',
      customerEmail: 'customer@example.com',
      department: 'OPEN_TRANSPORT',
      emailMessage: {
        id: 'email-1',
        subject: 'Order 001',
        bodyText: 'Original',
        bodyHtml: null,
        fromEmail: 'customer@example.com',
        fromName: null,
        receivedAt: new Date('2026-06-01T00:00:00Z'),
        attachments: [],
      },
      missingFields: [],
      fields: [
        {
          key: 'pickup_date',
          label: 'Pickup date',
          value: '2026-06-01',
          confidence: 0.95,
          source: 'EMAIL',
        },
      ],
    };

    const replyEmailMessage: any = {
      id: 'reply-1',
      bodyText: 'Reply body',
      bodyHtml: null,
      attachments: [],
    };

    await (processor as any).processCustomerReply({
      replyEmailMessage,
      existingOrder,
      linkMatchType: 'REPLY_TOKEN',
    });

    expect(
      transportBookingValidationService.validateOrderFromFieldValues,
    ).toHaveBeenCalled();
    const args =
      transportBookingValidationService.validateOrderFromFieldValues.mock
        .calls[0][0];
    expect(args).toMatchObject({
      orderId: 'order-1',
      emailMessageId: 'reply-1',
      source: 'email',
    });
    expect(args.fieldValues).toEqual({
      pickup_date: '2026-06-01',
      delivery_city: 'Hanau',
    });
    expect(args.fieldMetaByKey).toMatchObject({
      pickup_date: { source: 'EMAIL', confidence: 0.95 },
      delivery_city: { source: 'EMAIL', confidence: 0.95 },
    });
  });
});
