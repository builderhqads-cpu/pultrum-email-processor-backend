import { Injectable } from '@nestjs/common';
import { EmailMessage } from '@prisma/client';
import { IncomingEmailContext } from './incoming-email-context';

@Injectable()
export class EmailContextMapperService {
  private normalizeSubject(subject: string) {
    const s = (subject || '').trim();
    if (!s) return '';
    const prefixes = [
      /^re\s*:\s*/i,
      /^fw\s*:\s*/i,
      /^fwd\s*:\s*/i,
      /^antwoord\s*:\s*/i,
      /^doorsturen\s*:\s*/i,
      /^sv\s*:\s*/i,
    ];
    let cur = s;
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of prefixes) {
        if (re.test(cur)) {
          cur = cur.replace(re, '').trim();
          changed = true;
        }
      }
    }
    return cur.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private parseProviderMessageId(graphMessageId: string) {
    const raw = (graphMessageId || '').trim();
    const idx = raw.indexOf(':');
    if (idx > 0) {
      return { provider: raw.slice(0, idx), id: raw.slice(idx + 1) };
    }
    return { provider: null, id: raw };
  }

  toIncomingEmailContext(email: Pick<
    EmailMessage,
    | 'graphMessageId'
    | 'conversationId'
    | 'threadKey'
    | 'messageIdHeader'
    | 'inReplyToHeader'
    | 'referencesHeader'
    | 'subject'
    | 'fromEmail'
    | 'bodyText'
  >): IncomingEmailContext {
    const parsed = this.parseProviderMessageId(email.graphMessageId);
    const provider = parsed.provider === 'imap' ? 'imap' : 'graph';
    const providerMessageId = parsed.id;

    const originalSubject = email.subject || '';
    const normalizedSubject = this.normalizeSubject(originalSubject);

    return {
      provider,
      providerMessageId,
      messageIdHeader: email.messageIdHeader ?? undefined,
      inReplyToHeader: email.inReplyToHeader ?? undefined,
      referencesHeader: email.referencesHeader ?? undefined,
      conversationId: email.conversationId ?? undefined,
      threadId: email.threadKey ?? undefined,
      normalizedSubject,
      originalSubject,
      fromEmail: email.fromEmail,
      bodyText: email.bodyText ?? undefined,
    };
  }
}

