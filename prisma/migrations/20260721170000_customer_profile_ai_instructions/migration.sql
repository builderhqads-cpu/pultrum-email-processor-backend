-- Move the AI guidance from per-field to the profile: the operator fills it in
-- one place, as prose that can also describe document-level structure rules
-- (e.g. "one order per TR block; the load and unload rows share the same LT").
ALTER TABLE "CustomerProfile" ADD COLUMN "aiInstructions" TEXT;

-- Carry over anything already typed per field so nothing is lost, prefixing each
-- line with the field key it referred to.
UPDATE "CustomerProfile" p
SET "aiInstructions" = sub.merged
FROM (
  SELECT "profileId", string_agg("key" || ': ' || "instruction", E'\n' ORDER BY "key") AS merged
  FROM "CustomerProfileField"
  WHERE "instruction" IS NOT NULL AND btrim("instruction") <> ''
  GROUP BY "profileId"
) AS sub
WHERE p."id" = sub."profileId" AND p."aiInstructions" IS NULL;

ALTER TABLE "CustomerProfileField" DROP COLUMN "instruction";
