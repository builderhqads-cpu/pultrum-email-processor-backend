-- Per-mailbox high-water mark: the sync only processes emails received at/after
-- this instant, so connecting a mailbox never pulls its historical backlog into
-- the (expensive) AI pipeline. Nullable/additive.
ALTER TABLE "Mailbox" ADD COLUMN "processMessagesFrom" TIMESTAMP(3);

-- Backfill existing mailboxes to "now" so they stop reaching back over old mail
-- from this point on (already-synced messages are deduped by message id anyway).
UPDATE "Mailbox" SET "processMessagesFrom" = NOW() WHERE "processMessagesFrom" IS NULL;
