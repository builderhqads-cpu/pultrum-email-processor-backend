-- AlterTable: content-derived signature to keep batch legs that share the same
-- externalReference distinct (Emergo: several trucks for one order number).
ALTER TABLE "TransportOrder" ADD COLUMN "legKey" TEXT;
