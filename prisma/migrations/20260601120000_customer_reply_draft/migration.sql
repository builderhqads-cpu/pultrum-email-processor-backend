-- CreateEnum
CREATE TYPE "CustomerReplyDraftStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "CustomerReplyDraft" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "aiRequestId" UUID,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CustomerReplyDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerReplyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReplyDraft_orderId_key" ON "CustomerReplyDraft"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReplyDraft_aiRequestId_key" ON "CustomerReplyDraft"("aiRequestId");

-- CreateIndex
CREATE INDEX "CustomerReplyDraft_status_idx" ON "CustomerReplyDraft"("status");

-- CreateIndex
CREATE INDEX "CustomerReplyDraft_aiRequestId_idx" ON "CustomerReplyDraft"("aiRequestId");

-- AddForeignKey
ALTER TABLE "CustomerReplyDraft" ADD CONSTRAINT "CustomerReplyDraft_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReplyDraft" ADD CONSTRAINT "CustomerReplyDraft_aiRequestId_fkey" FOREIGN KEY ("aiRequestId") REFERENCES "AiRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

