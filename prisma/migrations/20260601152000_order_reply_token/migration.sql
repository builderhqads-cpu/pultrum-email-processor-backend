-- AlterTable
ALTER TABLE "TransportOrder" ADD COLUMN     "conversationKey" TEXT,
ADD COLUMN     "lastCustomerReplyAt" TIMESTAMP(3),
ADD COLUMN     "replyToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TransportOrder_replyToken_key" ON "TransportOrder"("replyToken");

-- CreateIndex
CREATE INDEX "TransportOrder_replyToken_idx" ON "TransportOrder"("replyToken");

-- CreateIndex
CREATE INDEX "TransportOrder_conversationKey_idx" ON "TransportOrder"("conversationKey");
