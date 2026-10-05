/**
 * One-off backfill: fill historical cost/usage on cost-less AiCallLog rows
 * (Renato 2026-10-05), using the cost that already lives in AiRequest.responseJson.
 *
 * Why: Phase-1 cost capture only applies to NEW router calls; older AiCallLog
 * rows have costUsd/emailMessageId = null. AiRequest (per order) still holds the
 * router response with its usage, so we reconstruct the per-call cost from it.
 *
 * Accounting: the router bills several stages (context/extract/refine) and the
 * top-level `usage` only mirrors the last stage, so we SUM the stages (same as
 * extractAiCallUsage in the service). AiRequest is per-order, so one call shows
 * up N times with identical cost — we de-dup to one call per (email, minute).
 *
 * Safety: UPDATE-only on rows where costUsd IS NULL (idempotent, never doubles).
 * Reply-generation requests are ignored (only e-mail processing is in scope).
 *
 * Run locally:  node scripts/backfill-aicall-cost.js            (dry run)
 *               node scripts/backfill-aicall-cost.js --apply    (writes)
 * On the VM:    docker exec pultrum-api node scripts/backfill-aicall-cost.js --apply
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const costOf = (u) =>
  num(u && u.cost) ??
  num(u && u.total_cost) ??
  num(u && u.cost_details && u.cost_details.upstream_inference_cost);

// Mirror of extractAiCallUsage() in ai-extraction.service.ts.
function extractUsage(raw) {
  const stages = ['contextUsage', 'extractUsage', 'refineUsage']
    .map((k) => (raw && typeof raw[k] === 'object' ? raw[k] : null))
    .filter(Boolean);
  const model =
    (raw && typeof raw.model === 'string' && raw.model) ||
    (raw && raw.usage && typeof raw.usage.model === 'string' && raw.usage.model) ||
    null;
  if (stages.length) {
    let cost = 0, total = 0;
    for (const s of stages) {
      cost += costOf(s) ?? 0;
      total += num(s.total_tokens) ?? 0;
    }
    return { costUsd: cost, totalTokens: total || null, model };
  }
  const u = raw && raw.usage;
  return { costUsd: costOf(u), totalTokens: num(u && u.total_tokens), model };
}

const isProcessing = (rj) =>
  rj && typeof rj === 'object' && ('orders' in rj || 'isTransportOrder' in rj) && !('replyBody' in rj);

const minuteKey = (d) => new Date(Math.floor(new Date(d).getTime() / 60000) * 60000).toISOString();

(async () => {
  // 1) Processing AiRequests + their e-mail (via the order).
  const reqs = await prisma.aiRequest.findMany({
    select: { orderId: true, createdAt: true, responseJson: true },
    orderBy: { createdAt: 'asc' },
  });
  const orderIds = [...new Set(reqs.map((r) => r.orderId).filter(Boolean))];
  const orders = orderIds.length
    ? await prisma.transportOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, emailMessageId: true },
      })
    : [];
  const emailIdByOrder = new Map(orders.map((o) => [o.id, o.emailMessageId]));
  const emailIds = [...new Set([...emailIdByOrder.values()].filter(Boolean))];
  const emails = emailIds.length
    ? await prisma.emailMessage.findMany({
        where: { id: { in: emailIds } },
        select: { id: true, subject: true },
      })
    : [];
  const subjectByEmail = new Map(emails.map((e) => [e.id, (e.subject || '').trim()]));

  // 2) De-dup to distinct calls: one per (emailMessageId, minute).
  const callByKey = new Map();
  for (const r of reqs) {
    if (!isProcessing(r.responseJson)) continue;
    const emailId = emailIdByOrder.get(r.orderId) || null;
    if (!emailId) continue;
    const usage = extractUsage(r.responseJson);
    if (usage.costUsd == null) continue;
    const key = `${emailId}|${minuteKey(r.createdAt)}`;
    if (!callByKey.has(key)) {
      callByKey.set(key, {
        emailMessageId: emailId,
        createdAt: new Date(r.createdAt),
        subject: subjectByEmail.get(emailId) || '',
        ...usage,
      });
    }
  }
  const calls = [...callByKey.values()].sort((a, b) => a.createdAt - b.createdAt);

  // 3) Cost-less SUCCEEDED call-log rows to fill.
  const rows = await prisma.aiCallLog.findMany({
    where: { kind: 'eml-process', status: 'SUCCEEDED', costUsd: null },
    select: { id: true, createdAt: true, reference: true },
    orderBy: { createdAt: 'asc' },
  });
  const consumed = new Set();
  const pick = (call) => {
    const subj = call.subject.slice(0, 300);
    let best = null, bestDelta = Infinity;
    for (const row of rows) {
      if (consumed.has(row.id)) continue;
      const subjMatch = subj && (row.reference || '').trim() === subj;
      const delta = Math.abs(new Date(row.createdAt) - call.createdAt);
      // Prefer a subject match; among those, the nearest time. If no subject
      // matches at all, allow a nearest-time match within 2h.
      const score = subjMatch ? delta : delta + 1e12;
      if (score < bestDelta && (subjMatch || delta < 2 * 3600 * 1000)) {
        best = row;
        bestDelta = score;
      }
    }
    return best;
  };

  const updates = [];
  let unmatched = 0;
  for (const call of calls) {
    const row = pick(call);
    if (!row) { unmatched += 1; continue; }
    consumed.add(row.id);
    updates.push({ id: row.id, call });
  }

  const totalCost = calls.reduce((a, c) => a + (c.costUsd || 0), 0);
  const matchedCost = updates.reduce((a, u) => a + (u.call.costUsd || 0), 0);
  console.log(
    `distinct calls: ${calls.length} | cost-less rows: ${rows.length} | matched: ${updates.length} | unmatched: ${unmatched}`,
  );
  console.log(
    `total historical cost (USD): ${totalCost.toFixed(5)} | matched cost: ${matchedCost.toFixed(5)}`,
  );

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to persist.');
    await prisma.$disconnect();
    return;
  }

  for (const u of updates) {
    await prisma.aiCallLog.update({
      where: { id: u.id },
      data: {
        costUsd: u.call.costUsd,
        totalTokens: u.call.totalTokens,
        model: u.call.model,
        emailMessageId: u.call.emailMessageId,
      },
    });
  }
  console.log(`\nAPPLIED — updated ${updates.length} AiCallLog rows.`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
