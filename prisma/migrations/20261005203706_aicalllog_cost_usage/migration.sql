-- AlterTable
ALTER TABLE "AiCallLog" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "costUsd" DOUBLE PRECISION,
ADD COLUMN     "emailMessageId" UUID,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "promptTokens" INTEGER,
ADD COLUMN     "totalTokens" INTEGER;

-- CreateIndex
CREATE INDEX "AiCallLog_emailMessageId_idx" ON "AiCallLog"("emailMessageId");
