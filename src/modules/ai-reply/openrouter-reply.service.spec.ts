import { OpenRouterReplyService } from './openrouter-reply.service';

describe('OpenRouterReplyService', () => {
  const originalFetch = global.fetch;

  function mockFetchJson(body: unknown, status = 200) {
    return jest.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response),
    ) as unknown as typeof fetch;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('normalizes OpenRouter reply JSON into subject and body', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'OPENROUTER_API_KEY') return 'test-key';
        if (key === 'OPENROUTER_REPLY_MODEL') return 'openai/gpt-4o-mini';
        if (key === 'OPENROUTER_REPLY_TIMEOUT_MS') return '60000';
        return undefined;
      }),
    };

    global.fetch = mockFetchJson({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: 'Additional transport information required',
              body: 'Good morning,\n\nPlease confirm the pickup date.\n\nKind regards,',
            }),
          },
        },
      ],
      usage: { total_tokens: 123 },
    });

    const service = new OpenRouterReplyService(configService);

    const result = await service.generateMissingInfoReply({
      orderId: 'order-1',
      customerEmail: 'test@example.com',
      subject: 'Order 01',
      bodyText: 'Body',
      missingFields: [
        {
          key: 'pickup_date',
          label: 'Pickup date',
          reason: 'Missing',
        },
      ],
      detectedFields: [],
      language: 'en',
    });

    expect(result.subject).toBe('Additional transport information required');
    expect(result.body).toBe(
      [
        'Good morning,',
        'Thank you for your transport request.',
        'To continue processing your order, we still need the following information:',
        '- Pickup date',
        'Once we receive these details, we will continue processing your order.',
        'Kind regards,',
        'Pultrum',
      ].join('\n\n'),
    );
    expect(result.model).toBe('openai/gpt-4o-mini');
  });

  it('includes recommended (validationWarnings) fields in the "Also helpful" line', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'OPENROUTER_API_KEY') return 'test-key';
        return undefined;
      }),
    };

    global.fetch = mockFetchJson({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: 'Additional transport information required',
              body: 'Good morning,\n\nPlease confirm the details.\n\nKind regards,',
            }),
          },
        },
      ],
    });

    const service = new OpenRouterReplyService(configService);

    const result = await service.generateMissingInfoReply({
      orderId: 'order-1',
      customerEmail: 'test@example.com',
      subject: 'Order 01',
      bodyText: 'Body',
      missingFields: [{ key: 'pickup_date', label: 'Pickup date', reason: 'Missing' }],
      validationWarnings: [
        { key: 'pickup_phone', label: 'Pickup phone', reason: 'Recommended' },
        { key: 'pickup_contact', label: 'Pickup contact', reason: 'Recommended' },
      ],
      detectedFields: [],
      language: 'en',
    });

    // Required field stays in the blocking bullet list...
    expect(result.body).toContain('- Pickup date');
    // ...and recommended fields appear only in the non-blocking helpful line.
    expect(result.body).toContain(
      'It would also be helpful to receive: Pickup phone, Pickup contact.',
    );
  });
});
