ALTER TABLE "Mailbox"
ADD COLUMN "displayName" TEXT;

UPDATE "Mailbox"
SET "displayName" = CASE
  WHEN "department" = 'OPEN_TRANSPORT' THEN 'Open transport'
  WHEN "department" = 'STUK_GOED' THEN 'General cargo'
  ELSE "email"
END
WHERE "displayName" IS NULL;

ALTER TABLE "Mailbox"
ALTER COLUMN "displayName" SET NOT NULL;
