import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

export type AiStatusEvent = {
  type: 'incident' | 'recovery';
  at: string; // ISO
  message?: string;
  durationMs?: number;
};

/**
 * Service-status view of the AI pipeline (Touchpix-style), derived from the
 * AiRequest history: current status, uptime over 7/30/90 days and an
 * incident/recovery timeline. A FAILED call opens an incident; the next
 * non-failed call closes it (recovery). Note: AiRequest is order-scoped, so a
 * total router outage that happens BEFORE any order is created is not captured
 * here — extend with a dedicated log if that becomes necessary.
 */
@Injectable()
export class AiStatusService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private isConfigured(): boolean {
    const url = (
      this.configService.get<string>('AI_API_URL') ||
      this.configService.get<string>('AI_API_BASE_URL') ||
      ''
    ).trim();
    return Boolean(url);
  }

  /** Human, short cause for an incident, best-effort from the failed response. */
  private summarizeError(responseJson: unknown): string | undefined {
    if (responseJson == null) return undefined;
    let text = '';
    if (typeof responseJson === 'string') {
      text = responseJson;
    } else if (typeof responseJson === 'object') {
      const o = responseJson as Record<string, unknown>;
      text = String(o.error ?? o.message ?? o.detail ?? o.raw ?? '');
      if (!text) {
        try {
          text = JSON.stringify(o);
        } catch {
          text = '';
        }
      }
    }
    text = text.trim();
    if (!text) return undefined;

    const low = text.toLowerCase();
    if (/402|insufficient|credit|quota|billing/.test(low)) {
      return 'Sem créditos no router (402)';
    }
    if (/401|403|unauthorized|forbidden|api[_ -]?key|token/.test(low)) {
      return 'Autenticação / token';
    }
    if (/timeout|timed out|etimedout|econnrefused|network|socket|fetch failed/.test(low)) {
      return 'Timeout / conexão com o router';
    }
    if (/50\d|internal server|bad gateway|unavailable|gateway timeout/.test(low)) {
      return 'Erro do servidor do router (5xx)';
    }
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }

  async getStatus() {
    const configured = this.isConfigured();
    const now = Date.now();
    const since90 = new Date(now - WINDOW_DAYS * DAY_MS);

    // Read the call-level log (every /eml-process call), NOT AiRequest — the log
    // captures router-down / 402 / timeout that fail before any order exists.
    const rows = await this.prismaService.aiCallLog.findMany({
      where: { createdAt: { gte: since90 } },
      select: { status: true, createdAt: true, error: true },
      orderBy: { createdAt: 'asc' },
    });

    // Uptime = successful / total within the window. 3 decimals like reference.
    const uptime = (days: number): number => {
      const since = now - days * DAY_MS;
      let ok = 0;
      let failed = 0;
      for (const r of rows) {
        if (r.createdAt.getTime() < since) continue;
        if (r.status === 'FAILED') failed += 1;
        else ok += 1;
      }
      const total = ok + failed;
      if (total === 0) return 100;
      return Math.round((ok / total) * 100000) / 1000;
    };

    // Incident/recovery timeline.
    const events: AiStatusEvent[] = [];
    let down = false;
    let incidentAt: Date | null = null;
    for (const r of rows) {
      const failed = r.status === 'FAILED';
      if (failed && !down) {
        down = true;
        incidentAt = r.createdAt;
        events.push({
          type: 'incident',
          at: r.createdAt.toISOString(),
          message: this.summarizeError(r.error),
        });
      } else if (!failed && down) {
        down = false;
        events.push({
          type: 'recovery',
          at: r.createdAt.toISOString(),
          durationMs: incidentAt
            ? r.createdAt.getTime() - incidentAt.getTime()
            : undefined,
        });
        incidentAt = null;
      }
    }

    let succeeded = 0;
    let failedCount = 0;
    for (const r of rows) {
      if (r.status === 'FAILED') failedCount += 1;
      else succeeded += 1;
    }

    const lastRow = rows.length ? rows[rows.length - 1] : null;

    return {
      configured,
      status: !configured ? 'not_configured' : down ? 'incident' : 'operational',
      ongoingSince: down && incidentAt ? incidentAt.toISOString() : null,
      uptime: { d7: uptime(7), d30: uptime(30), d90: uptime(90) },
      counts: { succeeded, failed: failedCount, empty: 0, total: rows.length },
      lastRequestAt: lastRow ? lastRow.createdAt.toISOString() : null,
      windowDays: WINDOW_DAYS,
      // Newest first, capped.
      events: events.slice(-20).reverse(),
    };
  }
}
