-- Per-mailbox email signature (appended to outgoing replies). Nullable/additive.
ALTER TABLE "Mailbox" ADD COLUMN "signature" TEXT;
