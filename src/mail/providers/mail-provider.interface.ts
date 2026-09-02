export interface NormalizedAttachment {
  providerAttachmentId?: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  contentBase64?: string;
}

export interface NormalizedEmail {
  provider: 'graph' | 'imap';
  providerMessageId: string;
  conversationId?: string;
  messageIdHeader?: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  threadKey?: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  rawMimeBase64?: string;
  rawMimeFileName?: string;
  rawMimeMimeType?: string;
  receivedAt: Date;
  hasAttachments: boolean;
  attachments?: NormalizedAttachment[];
}

export interface MailProvider {
  /**
   * List message HEADERS matching the sync window (no raw MIME download). Cheap,
   * so the caller can dedup against the DB before fetching any .eml. `since` is a
   * high-water mark: only return messages received at/after it.
   */
  listMessages(since?: Date): Promise<NormalizedEmail[]>;

  /**
   * Download the raw MIME (.eml, base64) for a single message. Returns null when
   * unavailable, or when the provider already included it in listMessages (IMAP).
   */
  fetchRawMime(providerMessageId: string): Promise<string | null>;
}
