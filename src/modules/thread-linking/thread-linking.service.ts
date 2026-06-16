import { Injectable } from '@nestjs/common';
import { EmailLinkMethod, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IncomingEmailContext } from './incoming-email-context';

type LinkMatch = { type: EmailLinkMethod; orderId: string };

@Injectable()
export class ThreadLinkingService {
  constructor(private readonly prismaService: PrismaService) {}

  private extractRenovoToken(text: string) {
    const m = (text || '').match(/\[(RENOVO|PULTRUM)-([A-Za-z0-9]+)\]/i);
    if (!m?.[2]) return null;
    return { prefix: (m[1] || '').toString().toUpperCase(), short: m[2].toString().trim() };
  }

  private normalizeSubject(subject: string) {
    const s = (subject || '').trim();
    if (!s) return '';
    // Remove common reply/forward prefixes repeatedly
    const prefixes = [
      /^re\s*:\s*/i,
      /^fw\s*:\s*/i,
      /^fwd\s*:\s*/i,
      /^antwoord\s*:\s*/i,
      /^doorsturen\s*:\s*/i,
      /^sv\s*:\s*/i, // "sv:" sometimes used
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

  private parseMessageIdList(raw: string | null | undefined) {
    const text = (raw || '').toString().trim();
    if (!text) return [];

    // Prefer extracting <...> blocks
    const matches = text.match(/<[^>]+>/g);
    if (matches?.length) {
      return matches.map((m) => m.trim()).filter(Boolean);
    }

    // Fallback: split by whitespace
    return text
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async findExistingOrderForIncomingEmail(input: {
    emailMessageId: string;
    context: IncomingEmailContext;
    combinedText: string;
  }): Promise<LinkMatch | null> {
    const { context, combinedText, emailMessageId } = input;

    // 1) Token-based link: [PULTRUM-<short>] (primary)
    const tokenMatch =
      this.extractRenovoToken(context.originalSubject) ||
      this.extractRenovoToken(combinedText);
    if (tokenMatch?.short) {
      const candidates = [
        `${tokenMatch.prefix}-${tokenMatch.short}`,
        // Backward/forward compatibility
        `RENOVO-${tokenMatch.short}`,
        `PULTRUM-${tokenMatch.short}`,
      ];

      const byToken = await this.prismaService.transportOrder.findFirst({
        where: {
          OR: [
            { renovoToken: { in: candidates } },
            { replyToken: { in: candidates } },
            { conversationKey: { in: candidates } },
          ],
        },
        select: { id: true },
      });
      if (byToken) return { type: EmailLinkMethod.REPLY_TOKEN, orderId: byToken.id };
    }

    // 1.5) Conversation-based link (Graph keeps the same conversationId across a
    // whole thread). Very reliable for Graph and independent of the subject, so
    // an operator can freely edit the reply subject without breaking linking.
    const conversationId = (context.conversationId || '').toString().trim();
    if (conversationId) {
      const candidates = await this.prismaService.emailMessage.findMany({
        where: { id: { not: emailMessageId }, conversationId },
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: { order: { select: { id: true } }, linkedOrderId: true },
      });
      for (const c of candidates) {
        const orderId = c.order?.id ?? c.linkedOrderId ?? null;
        if (orderId) return { type: EmailLinkMethod.REFERENCES, orderId };
      }
    }

    // 2) Header linking via In-Reply-To
    const inReplyToIds = this.parseMessageIdList(context.inReplyToHeader);
    if (inReplyToIds.length) {
      const referenced = await this.prismaService.emailMessage.findFirst({
        where: { id: { not: emailMessageId }, messageIdHeader: { in: inReplyToIds } },
        select: { order: { select: { id: true } }, linkedOrderId: true },
      });

      const orderId = referenced?.order?.id ?? referenced?.linkedOrderId ?? null;
      if (orderId) return { type: EmailLinkMethod.IN_REPLY_TO, orderId };
    }

    // 3) Header linking via References
    const refIds = this.parseMessageIdList(context.referencesHeader);
    if (refIds.length) {
      const referenced = await this.prismaService.emailMessage.findFirst({
        where: { id: { not: emailMessageId }, messageIdHeader: { in: refIds } },
        select: { order: { select: { id: true } }, linkedOrderId: true },
      });

      const orderId = referenced?.order?.id ?? referenced?.linkedOrderId ?? null;
      if (orderId) return { type: EmailLinkMethod.REFERENCES, orderId };
    }

    // 4) InternetMessageId linking (future Graph compatibility / dedupe)
    const incomingMessageId = (context.messageIdHeader || '').toString().trim();
    if (incomingMessageId) {
      const referenced = await this.prismaService.emailMessage.findFirst({
        where: { id: { not: emailMessageId }, messageIdHeader: incomingMessageId },
        select: { order: { select: { id: true } }, linkedOrderId: true },
      });

      const orderId = referenced?.order?.id ?? referenced?.linkedOrderId ?? null;
      if (orderId) return { type: EmailLinkMethod.INTERNET_MESSAGE_ID, orderId };
    }

    // 5) Same sender, waiting for response (fallback)
    const normalized = context.normalizedSubject;
    if (normalized && context.fromEmail) {
      const candidates = await this.prismaService.transportOrder.findMany({
        where: {
          status: OrderStatus.WAITING_CUSTOMER_RESPONSE,
          customerEmail: context.fromEmail,
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, emailMessage: { select: { subject: true } } },
      });
      for (const c of candidates) {
        const orig = this.normalizeSubject(c.emailMessage.subject || '');
        if (orig && orig === normalized) {
          return { type: EmailLinkMethod.SENDER_MATCH, orderId: c.id };
        }
      }
    }

    return null;
  }
}
