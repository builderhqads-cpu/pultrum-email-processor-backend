-- Niek #6: per-attachment document purpose ('loading' | 'unloading' | 'both'),
-- set from the AI's /eml-process attachment classification. Maps to Transpas
-- documenttype 86/87/91 in the XML (null -> default 92). Nullable/additive.
ALTER TABLE "Attachment" ADD COLUMN "documentPurpose" TEXT;
