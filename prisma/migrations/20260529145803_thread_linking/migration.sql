-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "inReplyToHeader" TEXT,
ADD COLUMN     "linkedOrderId" UUID,
ADD COLUMN     "messageIdHeader" TEXT,
ADD COLUMN     "referencesHeader" TEXT,
ADD COLUMN     "threadKey" TEXT;

-- AlterTable
ALTER TABLE "TransportOrder" ADD COLUMN     "renovoToken" TEXT;

-- CreateIndex
CREATE INDEX "EmailMessage_messageIdHeader_idx" ON "EmailMessage"("messageIdHeader");

-- CreateIndex
CREATE INDEX "EmailMessage_inReplyToHeader_idx" ON "EmailMessage"("inReplyToHeader");

-- CreateIndex
CREATE INDEX "EmailMessage_linkedOrderId_idx" ON "EmailMessage"("linkedOrderId");

-- CreateIndex
CREATE INDEX "TransportOrder_renovoToken_idx" ON "TransportOrder"("renovoToken");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_linkedOrderId_fkey" FOREIGN KEY ("linkedOrderId") REFERENCES "TransportOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
