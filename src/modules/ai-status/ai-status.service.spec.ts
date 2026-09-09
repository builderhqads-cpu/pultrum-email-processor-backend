import { AiStatusService } from './ai-status.service';

function makeService(rows: unknown[], configured = true) {
  const prisma = {
    aiCallLog: { findMany: jest.fn().mockResolvedValue(rows) },
  } as any;
  const config = {
    get: (key: string) =>
      configured && (key === 'AI_API_BASE_URL' || key === 'AI_API_URL')
        ? 'https://router.example'
        : '',
  } as any;
  return new AiStatusService(prisma, config);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

describe('AiStatusService', () => {
  it('reports operational with 100% uptime and no events when all calls succeed', async () => {
    const service = makeService([
      { status: 'SUCCEEDED', createdAt: minutesAgo(120), error: null },
      { status: 'SUCCEEDED', createdAt: minutesAgo(60), error: null },
      { status: 'SUCCEEDED', createdAt: minutesAgo(10), error: null },
    ]);

    const s = await service.getStatus();
    expect(s.status).toBe('operational');
    expect(s.uptime.d7).toBe(100);
    expect(s.events).toHaveLength(0);
    expect(s.ongoingSince).toBeNull();
    expect(s.counts).toMatchObject({ succeeded: 3, failed: 0 });
  });

  it('opens an incident on a failed call and closes it on the next success', async () => {
    const service = makeService([
      { status: 'SUCCEEDED', createdAt: minutesAgo(60), error: null },
      {
        status: 'FAILED',
        createdAt: minutesAgo(40),
        error: 'HTTP 402 insufficient credits',
      },
      { status: 'SUCCEEDED', createdAt: minutesAgo(19), error: null },
    ]);

    const s = await service.getStatus();
    expect(s.status).toBe('operational');
    expect(s.ongoingSince).toBeNull();
    expect(s.events.map((e) => e.type)).toEqual(['recovery', 'incident']);
    const incident = s.events.find((e) => e.type === 'incident');
    expect(incident?.message).toBe('Sem créditos no router (402)');
    const recovery = s.events.find((e) => e.type === 'recovery');
    expect(Math.round((recovery?.durationMs ?? 0) / 60000)).toBe(21);
    expect(s.uptime.d7).toBeCloseTo(66.667, 2);
  });

  it('stays in incident when the most recent call failed (router down)', async () => {
    const service = makeService([
      { status: 'SUCCEEDED', createdAt: minutesAgo(30), error: null },
      {
        status: 'FAILED',
        createdAt: minutesAgo(5),
        error: 'Timeout após 600000ms (router lento/indisponível)',
      },
    ]);

    const s = await service.getStatus();
    expect(s.status).toBe('incident');
    expect(s.ongoingSince).not.toBeNull();
    expect(s.events[0]).toMatchObject({
      type: 'incident',
      message: 'Timeout / conexão com o router',
    });
  });

  it('reports not_configured when no AI base url is set', async () => {
    const service = makeService([], false);
    const s = await service.getStatus();
    expect(s.status).toBe('not_configured');
    expect(s.configured).toBe(false);
  });
});
