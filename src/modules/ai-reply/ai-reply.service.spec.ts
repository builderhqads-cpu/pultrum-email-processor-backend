import { AiReplyService } from './ai-reply.service';

describe('AiReplyService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('creates a DRAFT using {output} response and ensures token in subject/body', async () => {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_BASE_URL') return 'https://example.com';
        if (key === 'AI_REPLY_API_URL') return '/generate-missing-info-reply';
        if (key === 'AI_API_KEY') return 'k';
        if (key === 'AI_REPLY_TIMEOUT_MS') return '120000';
        return undefined;
      }),
    };

    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ output: 'Olá\\n\\nInforme pickup_date.' }),
      } as any;
    }) as any;

    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn(async () => ({
          id: '3ce4d976-4731-436f-b6e3-dc818bac7e70',
          department: 'OPEN_TRANSPORT',
          customerEmail: 'c@example.com',
          replyToken: null,
          conversationKey: null,
          emailMessage: { subject: 'Order 002', bodyText: 'Body' },
          fields: [{ key: 'reference', label: 'Reference', value: 'Order 002', confidence: 0.9, source: 'EMAIL' }],
          missingFields: [{ key: 'pickup_date', label: 'Pickup date', reason: 'missing' }],
        })),
        update: jest.fn(async () => ({})),
      },
      customerReplyDraft: {
        upsert: jest.fn(async (args: any) => ({
          id: 'draft-1',
          ...args.create,
        })),
      },
    };

    const auditLogService: any = { log: jest.fn(async () => ({})) };
    const service = new AiReplyService(prismaService, configService, auditLogService);

    const res = await service.generateMissingInfoReply('3ce4d976-4731-436f-b6e3-dc818bac7e70');
    expect(res.ok).toBe(true);
    expect(prismaService.transportOrder.update).toHaveBeenCalled();
    expect(prismaService.customerReplyDraft.upsert).toHaveBeenCalled();

    const upsertArgs = prismaService.customerReplyDraft.upsert.mock.calls[0][0];
    expect(upsertArgs.create.subject).toContain('[PULTRUM-3ce4d976]');
    expect(upsertArgs.create.body).toContain('Reference: [PULTRUM-3ce4d976]');
    expect(upsertArgs.create.status).toBe('DRAFT');
  });
});

