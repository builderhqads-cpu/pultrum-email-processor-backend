import { OpenRouterExtractionService } from './openrouter-extraction.service';

describe('OpenRouterExtractionService', () => {
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

  function modelContent(output: unknown) {
    return {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { total_tokens: 123 },
    };
  }

  function configWithKey(): any {
    return {
      get: jest.fn((key: string) => {
        if (key === 'OPENROUTER_API_KEY') return 'test-key';
        if (key === 'OPENROUTER_MODEL') return 'openai/gpt-4o-mini';
        if (key === 'OPENROUTER_TIMEOUT_MS') return '60000';
        return undefined;
      }),
    };
  }

  function basePayload(overrides: Record<string, unknown> = {}) {
    return {
      orderId: 'order-1',
      customerEmail: 'test@example.com',
      subject: 'Order 01',
      bodyText: 'body',
      attachmentsText: null,
      combinedText: 'combined',
      requiredFields: [],
      detectedFields: [],
      missingFields: [],
      department: 'OPEN_TRANSPORT',
      language: null,
      ...overrides,
    } as any;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('keeps RECOMMENDED fields the model extracts, even when they are not in missingFields', async () => {
    // Regression guard: previously the result was filtered to payload.missingFields,
    // so RECOMMENDED fields (pickup_phone, pickup_contact, ...) were silently dropped.
    global.fetch = mockFetchJson(
      modelContent({
        detectedFields: [
          {
            key: 'pickup_contact',
            label: 'Pickup contact',
            value: 'John Hansen',
            confidence: 0.9,
          },
          {
            key: 'pickup_phone',
            label: 'Pickup phone',
            value: '+4512345678',
            confidence: 0.9,
          },
          {
            key: 'fixed_price',
            label: 'Fixed price',
            value: '250',
            confidence: 0.8,
          },
        ],
        missingFields: [],
      }),
    );

    const service = new OpenRouterExtractionService(configWithKey());

    // missingFields is empty on purpose: these keys would have been dropped before.
    const result = await service.extractTransportOrder(basePayload());

    expect(result.fields).toMatchObject({
      pickup_contact: 'John Hansen',
      pickup_phone: '+4512345678',
      fixed_price: '250',
    });
    expect(result.detectedFields.map((f) => f.key)).toEqual(
      expect.arrayContaining(['pickup_contact', 'pickup_phone', 'fixed_price']),
    );
    expect(result.model).toBe('openai/gpt-4o-mini');
  });

  it('drops keys that are not part of the extractable catalog (hallucinated keys)', async () => {
    global.fetch = mockFetchJson(
      modelContent({
        detectedFields: [
          {
            key: 'pickup_reference',
            label: 'Pickup reference',
            value: 'REF123',
            confidence: 0.95,
          },
          {
            key: 'totally_made_up_field',
            label: 'Nonsense',
            value: 'x',
            confidence: 0.99,
          },
        ],
        missingFields: [],
      }),
    );

    const service = new OpenRouterExtractionService(configWithKey());
    const result = await service.extractTransportOrder(basePayload());

    expect(result.fields).toMatchObject({ pickup_reference: 'REF123' });
    expect(result.fields.totally_made_up_field).toBeUndefined();
  });

  it('does not offer or accept duplicate canonical keys (weight/price/unit_*)', async () => {
    global.fetch = mockFetchJson(
      modelContent({
        detectedFields: [
          { key: 'weight', label: 'Weight', value: '50', confidence: 0.9 },
          { key: 'price', label: 'Price', value: '250', confidence: 0.9 },
        ],
        missingFields: [],
      }),
    );

    const service = new OpenRouterExtractionService(configWithKey());
    const result = await service.extractTransportOrder(basePayload());

    // The denied generic keys must be ignored; canonical keys are cargo_weight / fixed_price.
    expect(result.fields.weight).toBeUndefined();
    expect(result.fields.price).toBeUndefined();
  });

  it('reports REQUIRED/RECOMMENDED catalog fields that were not detected as missing', async () => {
    global.fetch = mockFetchJson(
      modelContent({ detectedFields: [], missingFields: [] }),
    );

    const service = new OpenRouterExtractionService(configWithKey());
    const result = await service.extractTransportOrder(basePayload());

    expect(result.fields).toEqual({});
    const missingKeys = result.missingFields.map((m) => m.key);
    // A REQUIRED field and a RECOMMENDED field both surface as missing.
    expect(missingKeys).toEqual(
      expect.arrayContaining(['pickup_date', 'pickup_phone']),
    );
  });
});
