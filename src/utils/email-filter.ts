/**
 * Deterministic inbound-email pre-filter (cost-cutting). After sync, before any
 * AI call, decide whether an email is worth processing at all. NO AI — pure
 * rules on the sender, subject and MIME headers.
 *
 * Conservative by design: it only skips HIGH-CONFIDENCE non-orders (auto-replies,
 * out-of-office, bounces, system senders). Anything ambiguous is let through, so
 * a real transport order is never dropped by the filter. Extra noisy senders can
 * be blocked per deployment via config (EMAIL_FILTER_BLOCK_SENDERS).
 */

export type EmailFilterInput = {
  fromEmail?: string | null;
  subject?: string | null;
  /** Decoded top MIME header block (everything before the first blank line). */
  rawHeaders?: string | null;
  /** Extra sender substrings to block (config-driven, lower-cased or not). */
  blockSenders?: string[];
};

export type EmailFilterDecision = {
  process: boolean;
  /** Machine-readable reason, e.g. "auto-submitted" or "ok". */
  reason: string;
};

const pass = (): EmailFilterDecision => ({ process: true, reason: 'ok' });
const skip = (reason: string): EmailFilterDecision => ({ process: false, reason });

export function classifyEmailForProcessing(
  input: EmailFilterInput,
): EmailFilterDecision {
  const from = (input.fromEmail ?? '').trim().toLowerCase();
  const subject = (input.subject ?? '').trim();
  const headers = input.rawHeaders ?? '';

  // 1. Bounce / delivery-status notification (DSN).
  if (/^\s*return-path:\s*<>\s*$/im.test(headers)) {
    return skip('bounce:null-return-path');
  }
  if (
    /^\s*content-type:\s*multipart\/report/im.test(headers) &&
    /report-type\s*=\s*["']?delivery-status/i.test(headers)
  ) {
    return skip('bounce:delivery-status');
  }

  // 2. Auto-reply / out-of-office (RFC 3834 + common vendor headers).
  if (/^\s*auto-submitted:\s*auto-(replied|generated|notified)/im.test(headers)) {
    return skip('auto-submitted');
  }
  if (/^\s*x-auto-response-suppress:/im.test(headers)) {
    return skip('x-auto-response-suppress');
  }
  if (/^\s*x-(autoreply|autorespond|auto-reply):/im.test(headers)) {
    return skip('x-autoreply');
  }
  if (/^\s*precedence:\s*(bulk|auto_reply|junk)\b/im.test(headers)) {
    return skip('precedence');
  }

  // 3. System senders that never carry a transport order. Kept intentionally
  //    narrow — "noreply@" style senders are NOT blocked by default (some client
  //    order systems send from them); add those via EMAIL_FILTER_BLOCK_SENDERS.
  const systemSenders = ['mailer-daemon@', 'postmaster@'];
  if (from && systemSenders.some((s) => from.includes(s))) {
    return skip(`system-sender:${from}`);
  }
  const blocked = (input.blockSenders ?? [])
    .map((b) => (b ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (from && blocked.some((b) => from.includes(b))) {
    return skip(`blocked-sender:${from}`);
  }

  // 4. Subject patterns for auto-reply / bounce (DE / NL / EN). Deliberately do
  //    NOT match "RE:"/"FW:" — those are often real customer replies with info.
  const subjectNoise: RegExp[] = [
    /^\s*automatische antwort/i, // DE out-of-office
    /^\s*automatisch antwoord/i, // NL out-of-office
    /^\s*(automatic reply|auto[-\s]?reply)/i,
    /\bout of office\b/i,
    /\bafwezig(heid)?\b/i,
    /\babwesenheit\b/i,
    /^\s*undeliverable\b/i,
    /\bmail delivery (failed|subsystem)\b/i,
    /\bdelivery (has )?failed\b/i,
    /\bnicht zustellbar\b/i,
  ];
  if (subject && subjectNoise.some((re) => re.test(subject))) {
    return skip('subject-auto-reply');
  }

  return pass();
}
