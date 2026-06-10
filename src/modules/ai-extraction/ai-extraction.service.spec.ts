import { AiExtractionService } from './ai-extraction.service';

describe('AiExtractionService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns null when AI_EXTRACTION_API_URL is not configured', async () => {
    const configService: any = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res).toBeNull();
  });

  it('parses fields from JSON response {fields:{...}}', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          fields: {
            pickup_date: '2026-06-01<br>',
            delivery_city: 'Hanau</div>',
          },
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.fields).toEqual({
      pickup_date: '2026-06-01',
      delivery_city: 'Hanau',
    });
    expect(res?.missingFields).toEqual([]);
  });

  it('parses fields from JSON response {fields:[{key,value}] }', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          fields: [
            { key: 'pickup_date', value: '2026-06-01<br>' },
            { key: 'cargo_weight', value: '50</div>' },
          ],
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.fields).toEqual({
      pickup_date: '2026-06-01',
      cargo_weight: '50',
    });
    expect(res?.missingFields).toEqual([]);
  });

  it('returns null on non-2xx responses', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: false,
        status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'bad request' }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res).toBeNull();
  });

  it('parses fields from gateway wrapper {output:\"<xml>\"}', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          model: 'x',
          output:
            '<transportRequest><fields>' +
            '<field key="pickup_date">2026-06-01</field>' +
            '<field key="delivery_address">Rodgaustraße 7&lt;br&gt;</field>' +
            '</fields></transportRequest>',
          usage: {},
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      customerEmail: 'a@b.com',
      subject: 'Order 001',
      bodyText: 'Body',
      attachmentsText: null,
      combinedText: 'Combined',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.fields).toEqual({
      pickup_date: '2026-06-01',
      delivery_address: 'Rodgaustraße 7',
    });
    expect(res?.missingFields).toEqual([]);
  });

  it('parses fields from chat-completions tool_calls function arguments', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_123',
                    type: 'function',
                    function: {
                      name: 'extract_transport_order',
                      arguments: JSON.stringify({
                        fields: {
                          pickup_date: '2026-06-01',
                          delivery_city: 'Hanau',
                        },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.fields).toEqual({
      pickup_date: '2026-06-01',
      delivery_city: 'Hanau',
    });
    expect(res?.missingFields).toEqual([]);
  });

  it('parses fields from responses-api function_call output arguments', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          output: [
            {
              type: 'function_call',
              name: 'extract_transport_order',
              arguments: JSON.stringify({
                fields: [
                  { key: 'pickup_reference', value: 'REF123' },
                  { key: 'cargo_weight', value: '50' },
                ],
              }),
            },
          ],
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.fields).toEqual({
      pickup_reference: 'REF123',
      cargo_weight: '50',
    });
    expect(res?.missingFields).toEqual([]);
  });

  it('parses missingFields from JSON response', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          fields: { pickup_date: '2026-06-01' },
          missingFields: [
            {
              key: 'pickup_phone',
              label: 'Pickup phone',
              reason: 'Not present in email body',
            },
          ],
        }),
      } as any;
    }) as any;

    const service = new AiExtractionService(
      configService,
      {} as any,
      { log: jest.fn() } as any,
    );

    const res = await service.extract({
      orderId: 'order-1',
      subject: 'x',
      bodyText: 'y',
      attachmentsText: null,
      combinedText: 'z',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'D',
      language: 'nl',
    });

    expect(res?.missingFields).toEqual([
      {
        key: 'pickup_phone',
        label: 'Pickup phone',
        reason: 'Not present in email body',
      },
    ]);
  });

  it('extractTransportOrder persists AI fields and missing fields', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_EXTRACTION_API_URL') return '/extract-transport-order';
        if (key === 'AI_API_KEY') return '';
        if (key === 'AI_EXTRACTION_TIMEOUT_MS') return '120000';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          fields: { pickup_date: '2026-06-01' },
          missingFields: [
            { key: 'delivery_city', label: 'Delivery city', reason: 'missing' },
          ],
          summary: 'ok',
        }),
      } as any;
    }) as any;

    const tx: any = {
      missingField: {
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({})),
      },
      orderField: {
        deleteMany: jest.fn(async () => ({})),
        upsert: jest.fn(async () => ({})),
      },
      transportOrder: { update: jest.fn(async () => ({})) },
    };

    const prismaService: any = {
      aiRequest: { create: jest.fn(async () => ({})) },
      transportOrder: {
        findUnique: jest.fn(async () => ({
          id: 'order-1',
          department: 'OPEN_TRANSPORT',
          customerEmail: 'c@example.com',
          emailMessage: {
            subject: 'Order 002',
            bodyText: 'Body',
            bodyHtml: '<div>Body</div>',
            fromEmail: 'c@example.com',
            attachments: [
              {
                fileName: 'a.xlsx',
                mimeType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                extractedText: 'Laaddatum: 2026-06-01',
                extractionStatus: 'SUCCESS',
              },
            ],
          },
          fields: [
            {
              key: 'reference',
              label: 'Reference',
              value: 'Order 002',
              source: 'EMAIL',
              confidence: 0.9,
            },
          ],
          missingFields: [
            { key: 'pickup_date', label: 'Pickup date', reason: 'missing' },
          ],
        })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const auditLogService: any = { log: jest.fn(async () => ({})) };
    const service = new AiExtractionService(
      configService,
      prismaService,
      auditLogService,
    );

    const res = await service.extractTransportOrder('order-1');
    expect(res).toEqual({
      ok: true,
      fieldsCount: 1,
      missingCount: 1,
      missingFields: [
        { key: 'delivery_city', label: 'Delivery city', reason: 'missing' },
      ],
    });

    expect(auditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AI_EXTRACTION_REQUESTED' }),
    );
    expect(auditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AI_EXTRACTION_COMPLETED' }),
    );

    expect(tx.orderField.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: 'AI' }),
      }),
    );
    expect(tx.orderField.upsert).toHaveBeenCalled();
    expect(tx.missingField.createMany).not.toHaveBeenCalled();
  });
});
