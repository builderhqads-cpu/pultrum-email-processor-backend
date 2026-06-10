export type IncomingEmailContext = {
  provider: 'imap' | 'graph';
  providerMessageId: string;
  messageIdHeader?: string;
  threadId?: string;
  conversationId?: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  normalizedSubject: string;
  originalSubject: string;
  fromEmail: string;
  bodyText?: string;
};

