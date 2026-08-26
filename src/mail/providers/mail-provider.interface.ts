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
  // `since` is a high-water mark: only return messages received at/after it.
  syncInbox(limit?: number, since?: Date): Promise<NormalizedEmail[]>;
}
