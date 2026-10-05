import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
// Aggregate "per day" in the operator's local day (Niek): Europe/Amsterdam.
const REPORT_TZ = 'Europe/Amsterdam';
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export type GroupBy = 'day' | 'customer' | 'model' | 'day_customer';

type Bucket = {
  calls: number;
  succeeded: number;
  failed: number;
  costUsd: number;
  tokens: number;
  emails: Set<string>;
  models: Map<string, number>;
};

function emptyBucket(): Bucket {
  return {
    calls: 0,
    succeeded: 0,
    failed: 0,
    costUsd: 0,
    tokens: 0,
    emails: new Set<string>(),
    models: new Map<string, number>(),
  };
}

// Most-used model in a bucket (so a customer/day row can show "which model").
function topModel(models: Map<string, number>): string {
  let best = '';
  let bestN = -1;
  for (const [m, n] of models) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best || '(desconhecido)';
}

const round = (n: number, d = 6) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Processing/cost audit (Renato 2026-10-05). Aggregates AiCallLog (one row per
 * router call, with cost/usage captured in Phase 1) joined to the e-mail's
 * sender, resolved to a customer. Cost is summed PER CALL (never per order, so
 * it is not inflated) and is available only from the Phase-1 rollout onward.
 */
@Injectable()
export class AuditReportsService {
  constructor(private readonly prismaService: PrismaService) {}

  async emailStats(params: {
    from?: string;
    to?: string;
    groupBy?: GroupBy;
  }): Promise<{
    summary: {
      from: string;
      to: string;
      timezone: string;
      totalCalls: number;
      totalEmails: number;
      succeeded: number;
      failed: number;
      totalCostUsd: number;
      avgCostPerEmail: number;
      customerCount: number;
    };
    groupBy: GroupBy;
    rows: Array<Record<string, string | number>>;
  }> {
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : new Date();
    const from = params.from
      ? new Date(`${params.from}T00:00:00.000`)
      : new Date(Date.now() - 30 * DAY_MS);
    const groupBy: GroupBy = params.groupBy ?? 'day';

    const calls = await this.prismaService.aiCallLog.findMany({
      where: { kind: 'eml-process', createdAt: { gte: from, lte: to } },
      select: {
        createdAt: true,
        status: true,
        costUsd: true,
        totalTokens: true,
        emailMessageId: true,
        model: true,
      },
    });

    // Sender e-mail per call, to resolve the customer.
    const emailIds = [
      ...new Set(
        calls.map((c) => c.emailMessageId).filter((id): id is string => !!id),
      ),
    ];
    const emails = emailIds.length
      ? await this.prismaService.emailMessage.findMany({
          where: { id: { in: emailIds } },
          select: { id: true, fromEmail: true },
        })
      : [];
    const senderByEmailId = new Map(
      emails.map((e) => [e.id, (e.fromEmail || '').trim().toLowerCase()]),
    );

    // Build an address -> customer-name map from the customer profiles.
    const profiles = await this.prismaService.customerProfile.findMany({
      select: {
        name: true,
        contactEmail: true,
        emails: { select: { email: true } },
      },
    });
    const addrToCustomer = new Map<string, string>();
    for (const p of profiles) {
      const addrs = [p.contactEmail, ...p.emails.map((e) => e.email)].filter(
        (a): a is string => !!a,
      );
      for (const a of addrs) addrToCustomer.set(a.trim().toLowerCase(), p.name);
    }

    const customerFor = (emailId: string | null): string => {
      if (!emailId) return '(sem e-mail)';
      const sender = senderByEmailId.get(emailId);
      if (!sender) return '(desconhecido)';
      const byProfile = addrToCustomer.get(sender);
      if (byProfile) return byProfile;
      return sender.split('@')[1] || sender;
    };

    const buckets = new Map<string, Bucket>();
    const bucket = (key: string): Bucket => {
      let b = buckets.get(key);
      if (!b) {
        b = emptyBucket();
        buckets.set(key, b);
      }
      return b;
    };

    const totals = emptyBucket();
    const allCustomers = new Set<string>();

    for (const c of calls) {
      const day = dayFmt.format(c.createdAt);
      const customer = customerFor(c.emailMessageId);
      const model = c.model || '(desconhecido)';
      allCustomers.add(customer);

      const key =
        groupBy === 'day'
          ? day
          : groupBy === 'customer'
            ? customer
            : groupBy === 'model'
              ? model
              : `${day}\u0000${customer}`;

      for (const b of [bucket(key), totals]) {
        b.calls += 1;
        if (c.status === 'SUCCEEDED') b.succeeded += 1;
        else b.failed += 1;
        if (typeof c.costUsd === 'number') b.costUsd += c.costUsd;
        if (typeof c.totalTokens === 'number') b.tokens += c.totalTokens;
        if (c.emailMessageId) b.emails.add(c.emailMessageId);
        b.models.set(model, (b.models.get(model) ?? 0) + 1);
      }
    }

    const rows = [...buckets.entries()]
      .map(([key, b]) => {
        const base = {
          emails: b.emails.size,
          calls: b.calls,
          succeeded: b.succeeded,
          failed: b.failed,
          costUsd: round(b.costUsd),
          tokens: b.tokens,
          avgCostPerEmail: b.emails.size ? round(b.costUsd / b.emails.size) : 0,
          model: topModel(b.models),
        };
        if (groupBy === 'day') return { date: key, ...base };
        if (groupBy === 'customer') return { customer: key, ...base };
        if (groupBy === 'model') return base; // base.model already = this group
        const [date, customer] = key.split('\u0000');
        return { date, customer, ...base };
      })
      .sort((a, b) => {
        // day/day_customer newest first by date, else by cost desc.
        if ('date' in a && 'date' in b && a.date !== b.date) {
          return (b.date as string).localeCompare(a.date as string);
        }
        return (b.costUsd as number) - (a.costUsd as number);
      });

    return {
      summary: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: REPORT_TZ,
        totalCalls: totals.calls,
        totalEmails: totals.emails.size,
        succeeded: totals.succeeded,
        failed: totals.failed,
        totalCostUsd: round(totals.costUsd),
        avgCostPerEmail: totals.emails.size
          ? round(totals.costUsd / totals.emails.size)
          : 0,
        customerCount: allCustomers.size,
      },
      groupBy,
      rows,
    };
  }

  /** Same data as CSV (Excel-friendly: semicolon separator, CRLF). */
  toCsv(result: Awaited<ReturnType<AuditReportsService['emailStats']>>): string {
    const {groupBy, rows} = result;
    const metricCols = ['emails', 'calls', 'succeeded', 'failed', 'costUsd', 'avgCostPerEmail', 'tokens', 'model'];
    const headers =
      groupBy === 'day'
        ? ['date', ...metricCols]
        : groupBy === 'customer'
          ? ['customer', ...metricCols]
          : groupBy === 'model'
            ? ['model', 'emails', 'calls', 'succeeded', 'failed', 'costUsd', 'avgCostPerEmail', 'tokens']
            : ['date', 'customer', ...metricCols];

    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(';')];
    for (const row of rows) {
      lines.push(headers.map((h) => esc((row as any)[h])).join(';'));
    }
    return lines.join('\r\n');
  }
}
