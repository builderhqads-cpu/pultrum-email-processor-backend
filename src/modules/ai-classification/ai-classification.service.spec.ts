import { AiClassificationService } from './ai-classification.service';

describe('AiClassificationService', () => {
  const originalFetch = global.fetch;

  function config(overrides: Record<string, string | undefined> = {}): any {
    const base: Record<string, string | undefined> = {
      AI_API_BASE_URL: 'http://localhost:3000',
      AI_CLASSIFICATION_API_URL: '/ai-test/classify-email',
      AUTO_AI_CLASSIFICATION_ENABLED: 'true',
      ...overrides,
    };
    return { get: (key: string) => base[key] };
  }

  function mockFetchJson(body: unknown, status = 200) {
    return jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  const payload = {
    emailId: 'email-1',
    mailboxId: 'mb-1',
    department: 'OPEN_TRANSPORT',
    from: 'c@example.com',
    subject: 'Transport request',
    bodyText: 'Please arrange pickup and delivery.',
    attachmentsText: null,
    combinedText: 'Subject...\nBody...',
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('parses a transport-order classification', async () => {
    global.fetch = mockFetchJson({
      isTransportOrder: true,
      reason: 'Has pickup and delivery',
      language: 'en',
      priority: 'normal',
    });

    const service = new AiClassificationService(config());
    const result = await service.classify(payload);

    expect(result).toMatchObject({
      isTransportOrder: true,
      reason: 'Has pickup and delivery',
      language: 'en',
      priority: 'normal',
    });
  });

  it('parses a non-transport classification', async () => {
    global.fetch = mockFetchJson({
      isTransportOrder: false,
      reason: 'Newsletter',
      language: 'en',
      priority: 'low',
    });

    const service = new AiClassificationService(config());
    const result = await service.classify(payload);

    expect(result?.isTransportOrder).toBe(false);
  });

  it('returns null when disabled (safety net: caller proceeds)', async () => {
    global.fetch = mockFetchJson({ isTransportOrder: false });
    const service = new AiClassificationService(
      config({ AUTO_AI_CLASSIFICATION_ENABLED: 'false' }),
    );
    expect(await service.classify(payload)).toBeNull();
  });

  it('returns null when base URL is not configured', async () => {
    const service = new AiClassificationService(
      config({ AI_API_BASE_URL: undefined }),
    );
    expect(await service.classify(payload)).toBeNull();
  });

  it('returns null on API error (never blocks)', async () => {
    global.fetch = mockFetchJson({ error: 'boom' }, 500);
    const service = new AiClassificationService(config());
    expect(await service.classify(payload)).toBeNull();
  });

  it('returns null when the response is undecidable (no boolean)', async () => {
    global.fetch = mockFetchJson({ reason: 'unsure' });
    const service = new AiClassificationService(config());
    expect(await service.classify(payload)).toBeNull();
  });

  it('reads the classification when wrapped under data', async () => {
    global.fetch = mockFetchJson({ data: { isTransportOrder: true } });
    const service = new AiClassificationService(config());
    const result = await service.classify(payload);
    expect(result?.isTransportOrder).toBe(true);
  });
});
