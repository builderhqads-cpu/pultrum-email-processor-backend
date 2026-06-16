import { MailProvider, NormalizedEmail } from './mail-provider.interface';
import { GraphAuthService } from '../../modules/graph/graph-auth.service';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { htmlToPlainText } from '../../utils/sanitize';

type GraphMessage = {
  id: string;
  conversationId?: string;
  from?: {
    emailAddress?: {
      address?: string;
      name?: string;
    };
  };
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  hasAttachments?: boolean;
};

export class GraphMailProvider implements MailProvider {
  constructor(
    private readonly graphAuthService: GraphAuthService,
    private readonly mailboxEmail: string,
  ) {}

  async syncInbox(limit = 10): Promise<NormalizedEmail[]> {
    const client = await this.graphAuthService.getAuthenticatedClient(
      this.mailboxEmail,
    );
    const response = await client
      .api(
        `/users/${encodeURIComponent(this.mailboxEmail)}/mailFolders/inbox/messages`,
      )
      .top(limit)
      .orderby('receivedDateTime desc')
      .select(
        'id,conversationId,internetMessageId,from,subject,bodyPreview,body,receivedDateTime,hasAttachments',
      )
      .get();

    const messages = (response?.value ?? []) as GraphMessage[];

    const normalized: NormalizedEmail[] = [];

    for (const m of messages) {
      const fromEmail = m.from?.emailAddress?.address || '';
      const fromName = m.from?.emailAddress?.name || undefined;
      const receivedAt = m.receivedDateTime
        ? new Date(m.receivedDateTime)
        : new Date();
      const contentType = (m.body?.contentType || '').toLowerCase();
      const fullContent = m.body?.content ?? '';

      // For HTML emails, Graph's `bodyPreview` is truncated to ~255 chars.
      // Derive the full plain-text body from `body.content` instead, and only
      // fall back to the preview when there is no body content at all.
      const bodyText =
        contentType === 'html'
          ? htmlToPlainText(fullContent) || m.bodyPreview || undefined
          : fullContent || m.bodyPreview || undefined;
      const bodyHtml =
        contentType === 'html' ? (fullContent || undefined) : undefined;

      let rawMimeBase64: string | undefined;
      try {
        const buffer = (await client
          .api(
            `/users/${encodeURIComponent(this.mailboxEmail)}/messages/${encodeURIComponent(m.id)}/$value`,
          )
          .responseType(ResponseType.ARRAYBUFFER)
          .get()) as ArrayBuffer;
        rawMimeBase64 = Buffer.from(buffer).toString('base64');
      } catch {
        rawMimeBase64 = undefined;
      }

      const internetMessageId = (m as { internetMessageId?: string })
        .internetMessageId;

      normalized.push({
        provider: 'graph',
        providerMessageId: m.id,
        conversationId: m.conversationId,
        // RFC 5322 Message-ID — needed to thread our outgoing reply and to link
        // the customer's reply back via References.
        messageIdHeader: internetMessageId || undefined,
        fromEmail,
        fromName,
        subject: m.subject ?? '',
        bodyText,
        bodyHtml,
        rawMimeBase64,
        rawMimeFileName: m.subject ? `${m.subject}.eml` : `${m.id}.eml`,
        rawMimeMimeType: 'message/rfc822',
        receivedAt,
        hasAttachments: !!m.hasAttachments,
      } satisfies NormalizedEmail);
    }

    return normalized;
  }
}
