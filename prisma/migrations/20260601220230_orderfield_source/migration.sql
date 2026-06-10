-- CreateEnum
CREATE TYPE "OrderFieldSource" AS ENUM ('EMAIL', 'REGEX', 'ATTACHMENT', 'OCR', 'AI', 'GENERATED', 'CALCULATED');

-- AlterTable
ALTER TABLE "OrderField" ADD COLUMN     "source" "OrderFieldSource" NOT NULL DEFAULT 'EMAIL';

-- CreateIndex
CREATE INDEX "OrderField_source_idx" ON "OrderField"("source");
