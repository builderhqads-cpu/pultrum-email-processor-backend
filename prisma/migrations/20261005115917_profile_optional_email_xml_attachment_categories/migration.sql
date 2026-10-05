-- contactEmail becomes optional (a profile can be created with only a name;
-- matched purely by opdrachtgever/content). @unique still holds (Postgres allows NULLs).
ALTER TABLE "CustomerProfile" ALTER COLUMN "contactEmail" DROP NOT NULL;

-- Per-customer switches for which attachment file types go in the XML documents
-- block. Absent/empty = include all (default). The .eml is never affected.
ALTER TABLE "CustomerProfile" ADD COLUMN "xmlAttachmentCategories" JSONB;
