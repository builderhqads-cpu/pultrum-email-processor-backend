export const QUEUE_MAILBOX_SYNC = 'mailbox-sync';
export const QUEUE_EMAIL_PROCESSING = 'email-processing';
export const QUEUE_AI_REQUEST = 'ai-request';
export const QUEUE_XML_DELIVERY = 'xml-delivery';

export const ALL_QUEUE_NAMES = [
  QUEUE_MAILBOX_SYNC,
  QUEUE_EMAIL_PROCESSING,
  QUEUE_AI_REQUEST,
  QUEUE_XML_DELIVERY,
] as const;
