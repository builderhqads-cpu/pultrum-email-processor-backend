-- Niek: per-order documents excluded from the XML <documents> block (attachment
-- ids, or the sentinel "email" for the original .eml). Reversible; empty = all.
ALTER TABLE "TransportOrder" ADD COLUMN "excludedDocumentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
