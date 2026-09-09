import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

const TERMINAL = new Set(['ACCEPTED', 'REJECTED', 'FAILED']);
const FAILURE = new Set(['REJECTED', 'FAILED']);

export type CgDeliveryLog = {
  id: string;
  status: string;
  at: string; // ISO (sentAt when available, else createdAt)
  reference: string | null;
  errorMessage?: string | null;
};

/**
 * Service-status view of the Creative Gears (Transpas) XML delivery integration,
 * derived from the XmlDelivery history: current status, uptime over 7/30/90 days
 * (accepted / terminal deliveries) and a log of the most recent deliveries so
 * operators can see what happened with each XML (accepted / rejected / failed).
 */
@Injectable()
export class CgStatusService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private isConfigured(): boolean {
    return Boolean(
      (this.configService.get<string>('CREATIVE_GEARS_API_URL') || '').trim(),
    );
  }

  private truncate(value?: string | null): string | null {
    const s = (value ?? '').toString().trim();
    if (!s) return null;
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }

  async getStatus() {
    const configured = this.isConfigured();
    const now = Date.now();
    const since90 = new Date(now - WINDOW_DAYS * DAY_MS);

    const rows = await this.prismaService.xmlDelivery.findMany({
      where: { createdAt: { gte: since90 } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        sentAt: true,
        errorMessage: true,
        order: { select: { externalReference: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Uptime = accepted / terminal (accepted + rejected + failed) in the window.
    // PENDING/SENT are still in flight and don't count either way.
    const uptime = (days: number): number => {
      const since = now - days * DAY_MS;
      let accepted = 0;
      let failed = 0;
      for (const r of rows) {
        if (r.createdAt.getTime() < since) continue;
        if (r.status === 'ACCEPTED') accepted += 1;
        else if (FAILURE.has(r.status)) failed += 1;
      }
      const total = accepted + failed;
      if (total === 0) return 100;
      return Math.round((accepted / total) * 100000) / 1000;
    };

    // Current status: the most recent TERMINAL delivery decides it.
    let mostRecentTerminal: string | null = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (TERMINAL.has(rows[i].status)) {
        mostRecentTerminal = rows[i].status;
        break;
      }
    }

    const counts = {
      accepted: 0,
      rejected: 0,
      failed: 0,
      pending: 0,
      sent: 0,
      total: rows.length,
    };
    for (const r of rows) {
      if (r.status === 'ACCEPTED') counts.accepted += 1;
      else if (r.status === 'REJECTED') counts.rejected += 1;
      else if (r.status === 'FAILED') counts.failed += 1;
      else if (r.status === 'PENDING') counts.pending += 1;
      else if (r.status === 'SENT') counts.sent += 1;
    }

    const deliveries: CgDeliveryLog[] = rows
      .slice(-25)
      .reverse()
      .map((r) => ({
        id: r.id,
        status: r.status,
        at: (r.sentAt ?? r.createdAt).toISOString(),
        reference: r.order?.externalReference ?? null,
        errorMessage: this.truncate(r.errorMessage),
      }));

    const lastRow = rows.length ? rows[rows.length - 1] : null;

    return {
      configured,
      status: !configured
        ? 'not_configured'
        : mostRecentTerminal && FAILURE.has(mostRecentTerminal)
          ? 'incident'
          : 'operational',
      uptime: { d7: uptime(7), d30: uptime(30), d90: uptime(90) },
      counts,
      lastDeliveryAt: lastRow ? (lastRow.sentAt ?? lastRow.createdAt).toISOString() : null,
      windowDays: WINDOW_DAYS,
      deliveries,
    };
  }
}
