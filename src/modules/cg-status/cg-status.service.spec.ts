import { CgStatusService } from './cg-status.service';

function makeService(rows: unknown[], configured = true) {
  const prisma = {
    xmlDelivery: { findMany: jest.fn().mockResolvedValue(rows) },
  } as any;
  const config = {
    get: (key: string) =>
      configured && key === 'CREATIVE_GEARS_API_URL'
        ? 'https://soap.example:14444/rest'
        : '',
  } as any;
  return new CgStatusService(prisma, config);
}

const minAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

describe('CgStatusService', () => {
  it('operational with 100% uptime when the latest terminal delivery was accepted', async () => {
    const service = makeService([
      {
        id: 'd1',
        status: 'ACCEPTED',
        createdAt: minAgo(60),
        sentAt: minAgo(59),
        errorMessage: null,
        order: { externalReference: 'J1' },
      },
      {
        id: 'd2',
        status: 'ACCEPTED',
        createdAt: minAgo(10),
        sentAt: minAgo(9),
        errorMessage: null,
        order: { externalReference: 'J2' },
      },
    ]);

    const s = await service.getStatus();
    expect(s.status).toBe('operational');
    expect(s.uptime.d7).toBe(100);
    expect(s.counts).toMatchObject({ accepted: 2, rejected: 0, failed: 0 });
    // Newest first, with reference + resolved timestamp.
    expect(s.deliveries[0]).toMatchObject({ status: 'ACCEPTED', reference: 'J2' });
    expect(s.deliveries).toHaveLength(2);
  });

  it('incident when the most recent terminal delivery failed, uptime reflects it', async () => {
    const service = makeService([
      {
        id: 'd1',
        status: 'ACCEPTED',
        createdAt: minAgo(60),
        sentAt: minAgo(59),
        errorMessage: null,
        order: { externalReference: 'J1' },
      },
      {
        id: 'd2',
        status: 'REJECTED',
        createdAt: minAgo(5),
        sentAt: minAgo(5),
        errorMessage: 'HTTP 500 empty body',
        order: { externalReference: 'J2' },
      },
      // A later PENDING must NOT flip the status back to operational.
      {
        id: 'd3',
        status: 'PENDING',
        createdAt: minAgo(1),
        sentAt: null,
        errorMessage: null,
        order: { externalReference: 'J3' },
      },
    ]);

    const s = await service.getStatus();
    expect(s.status).toBe('incident');
    // 1 accepted / 2 terminal.
    expect(s.uptime.d7).toBe(50);
    const rejected = s.deliveries.find((d) => d.status === 'REJECTED');
    expect(rejected?.errorMessage).toBe('HTTP 500 empty body');
    expect(s.counts).toMatchObject({ accepted: 1, rejected: 1, pending: 1 });
  });

  it('not_configured when the Creative Gears endpoint is unset', async () => {
    const service = makeService([], false);
    const s = await service.getStatus();
    expect(s.status).toBe('not_configured');
    expect(s.configured).toBe(false);
  });
});
