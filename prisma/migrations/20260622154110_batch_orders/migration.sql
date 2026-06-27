-- CreateEnum
CREATE TYPE "BatchImportStatus" AS ENUM ('DETECTED', 'PROCESSING', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED');

-- DropIndex
DROP INDEX "TransportOrder_emailMessageId_key";

-- AlterTable
ALTER TABLE "TransportOrder" ADD COLUMN     "batchImportId" UUID,
ADD COLUMN     "batchSequence" INTEGER,
ADD COLUMN     "externalReference" TEXT,
ADD COLUMN     "rawOrderText" TEXT,
ADD COLUMN     "sourceAttachmentId" UUID;

-- CreateTable
CREATE TABLE "BatchImport" (
    "id" UUID NOT NULL,
    "emailMessageId" UUID NOT NULL,
    "sourceAttachmentId" UUID,
    "status" "BatchImportStatus" NOT NULL DEFAULT 'DETECTED',
    "totalDetected" INTEGER NOT NULL DEFAULT 0,
    "totalCreated" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchImport_emailMessageId_idx" ON "BatchImport"("emailMessageId");

-- CreateIndex
CREATE INDEX "BatchImport_status_idx" ON "BatchImport"("status");

-- CreateIndex
CREATE INDEX "TransportOrder_emailMessageId_idx" ON "TransportOrder"("emailMessageId");

-- CreateIndex
CREATE INDEX "TransportOrder_batchImportId_idx" ON "TransportOrder"("batchImportId");

-- CreateIndex
CREATE INDEX "TransportOrder_externalReference_idx" ON "TransportOrder"("externalReference");

-- AddForeignKey
ALTER TABLE "TransportOrder" ADD CONSTRAINT "TransportOrder_batchImportId_fkey" FOREIGN KEY ("batchImportId") REFERENCES "BatchImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchImport" ADD CONSTRAINT "BatchImport_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
