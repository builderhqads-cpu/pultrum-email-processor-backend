import { MailProvider, NormalizedEmail } from './mail-provider.interface';
import { GraphAuthService } from '../../modules/graph/graph-auth.service';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(GraphMailProvider.name);
  // Safety cap when paginating (headers are cheap, but bound the work anyway).
  private static readonly MAX_MESSAGES = 500;
  private static readonly PAGE_SIZE = 50;

  constructor(
    private readonly graphAuthService: GraphAuthService,
    private readonly mailboxEmail: string,
    // When set, read this custom folder (e.g. "AI BOB") instead of the Inbox.
    private readonly folderName?: string | null,
  ) {}

  /** List message headers (no raw MIME). Paginated so a curated intake folder is
   *  read in full, without the old top-N blind spot. */
  async listMessages(since?: Date): Promise<NormalizedEmail[]> {
    const client = await this.graphAuthService.getAuthenticatedClient(
      this.mailboxEmail,
    );
    const base = `/users/${encodeURIComponent(this.mailboxEmail)}`;

    const folderSegment = await this.resolveFolderSegment(client, base);
    if (folderSegment === null) return []; // configured folder not found

    let request = client
      .api(`${base}/mailFolders/${folderSegment}/messages`)
      .top(GraphMailProvider.PAGE_SIZE)
      .orderby('receivedDateTime desc')
      .select(
        'id,conversationId,internetMessageId,from,subject,bodyPreview,body,receivedDateTime,hasAttachments',
      );

    // High-water mark: only list from the cutoff onward (Inbox mode). Filtering
    // on the same property we order by (receivedDateTime) is a supported combo.
    if (since) {
      request = request.filter(`receivedDateTime ge ${since.toISOString()}`);
    }

    const raw: GraphMessage[] = [];
    let page: any = await request.get();
    while (page) {
      raw.push(...((page?.value ?? []) as GraphMessage[]));
      const next = page?.['@odata.nextLink'] as string | undefined;
      if (!next || raw.length >= GraphMailProvider.MAX_MESSAGES) break;
      page = await client.api(next).get();
    }

    return raw
      .slice(0, GraphMailProvider.MAX_MESSAGES)
      .map((m) => this.normalizeHeader(m));
  }

  /** Download the raw .eml (base64) for one message. Null on failure. */
  async fetchRawMime(providerMessageId: string): Promise<string | null> {
    try {
      const client = await this.graphAuthService.getAuthenticatedClient(
        this.mailboxEmail,
      );
      const buffer = (await client
        .api(
          `/users/${encodeURIComponent(this.mailboxEmail)}/messages/${encodeURIComponent(providerMessageId)}/$value`,
        )
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      return Buffer.from(buffer).toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Resolve which folder to read. Empty folderName -> the well-known "inbox".
   * A custom folder (e.g. "AI BOB") is NOT addressable by name in the Graph
   * path, so look up its id by displayName (top level, then under Inbox).
   * Returns the URL segment to use, or null when a configured folder isn't found
   * (caller reads nothing, never the whole Inbox).
   */
  private async resolveFolderSegment(
    client: any,
    base: string,
  ): Promise<string | null> {
    const folderName = (this.folderName ?? '').trim();
    if (!folderName) return 'inbox';

    const escaped = folderName.replace(/'/g, "''"); // OData quote escaping
    const findIn = async (path: string): Promise<string | null> => {
      try {
        const res = await client
          .api(path)
          .filter(`displayName eq '${escaped}'`)
          .select('id,displayName')
          .top(10)
          .get();
        return ((res?.value ?? [])[0]?.id as string | undefined) ?? null;
      } catch {
        return null;
      }
    };

    const id =
      (await findIn(`${base}/mailFolders`)) ??
      (await findIn(`${base}/mailFolders/inbox/childFolders`));
    if (!id) {
      this.logger.warn(
        `Intake folder "${folderName}" not found for ${this.mailboxEmail}; ` +
          `skipping sync (0 messages).`,
      );
      return null;
    }
    return encodeURIComponent(id);
  }

  private normalizeHeader(m: GraphMessage): NormalizedEmail {
    const fromEmail = m.from?.emailAddress?.address || '';
    const fromName = m.from?.emailAddress?.name || undefined;
    const receivedAt = m.receivedDateTime
      ? new Date(m.receivedDateTime)
      : new Date();
    const contentType = (m.body?.contentType || '').toLowerCase();
    const fullContent = m.body?.content ?? '';

    // For HTML emails, Graph's `bodyPreview` is truncated to ~255 chars. Derive
    // the full plain-text body from `body.content` instead, and only fall back to
    // the preview when there is no body content at all.
    const bodyText =
      contentType === 'html'
        ? htmlToPlainText(fullContent) || m.bodyPreview || undefined
        : fullContent || m.bodyPreview || undefined;
    const bodyHtml =
      contentType === 'html' ? (fullContent || undefined) : undefined;

    const internetMessageId = (m as { internetMessageId?: string })
      .internetMessageId;

    return {
      provider: 'graph',
      providerMessageId: m.id,
      conversationId: m.conversationId,
      // RFC 5322 Message-ID — needed to thread our outgoing reply and to link the
      // customer's reply back via References.
      messageIdHeader: internetMessageId || undefined,
      fromEmail,
      fromName,
      subject: m.subject ?? '',
      bodyText,
      bodyHtml,
      // Filled later, ONLY for messages that turn out to be new (dedup first).
      rawMimeBase64: undefined,
      rawMimeFileName: m.subject ? `${m.subject}.eml` : `${m.id}.eml`,
      rawMimeMimeType: 'message/rfc822',
      receivedAt,
      hasAttachments: !!m.hasAttachments,
    } satisfies NormalizedEmail;
  }
}
