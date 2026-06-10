-- CreateEnum
CREATE TYPE "EmailLinkMethod" AS ENUM ('REPLY_TOKEN', 'IN_REPLY_TO', 'REFERENCES', 'INTERNET_MESSAGE_ID', 'SENDER_MATCH');

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "linkedByMethod" "EmailLinkMethod";

-- CreateIndex
CREATE INDEX "EmailMessage_linkedByMethod_idx" ON "EmailMessage"("linkedByMethod");
