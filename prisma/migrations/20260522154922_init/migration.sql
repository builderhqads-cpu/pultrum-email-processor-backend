-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Department" AS ENUM ('OPEN_TRANSPORT', 'STUK_GOED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('NEW_ORDER', 'MODIFICATION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('EMAIL_RECEIVED', 'PROCESSING', 'NEW_ORDER', 'MODIFICATION_DETECTED', 'MISSING_INFORMATION', 'WAITING_CUSTOMER_RESPONSE', 'READY_TO_XML', 'XML_GENERATED', 'SENT_TO_CREATIVE_GEARS', 'CREATIVE_GEARS_ACCEPTED', 'CREATIVE_GEARS_REJECTED', 'MANUAL_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "XmlDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "department" "Department" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" UUID NOT NULL,
    "mailboxId" UUID NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "status" "EmailStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "emailMessageId" UUID NOT NULL,
    "graphAttachmentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contentBase64" TEXT,
    "extractedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportOrder" (
    "id" UUID NOT NULL,
    "emailMessageId" UUID NOT NULL,
    "department" "Department" NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "OrderStatus" NOT NULL DEFAULT 'EMAIL_RECEIVED',
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "originalOrderReference" TEXT,
    "overallConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderField" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "missing" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissingField" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissingField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRequest" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "responseJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XmlDelivery" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "xmlPayload" TEXT NOT NULL,
    "status" "XmlDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "requestPayload" TEXT,
    "responsePayload" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XmlDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detailsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_email_key" ON "Mailbox"("email");

-- CreateIndex
CREATE INDEX "Mailbox_department_idx" ON "Mailbox"("department");

-- CreateIndex
CREATE INDEX "Mailbox_active_idx" ON "Mailbox"("active");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_graphMessageId_key" ON "EmailMessage"("graphMessageId");

-- CreateIndex
CREATE INDEX "EmailMessage_mailboxId_receivedAt_idx" ON "EmailMessage"("mailboxId", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_status_idx" ON "EmailMessage"("status");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_idx" ON "EmailMessage"("conversationId");

-- CreateIndex
CREATE INDEX "Attachment_emailMessageId_idx" ON "Attachment"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_emailMessageId_graphAttachmentId_key" ON "Attachment"("emailMessageId", "graphAttachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportOrder_emailMessageId_key" ON "TransportOrder"("emailMessageId");

-- CreateIndex
CREATE INDEX "TransportOrder_department_idx" ON "TransportOrder"("department");

-- CreateIndex
CREATE INDEX "TransportOrder_status_idx" ON "TransportOrder"("status");

-- CreateIndex
CREATE INDEX "TransportOrder_type_idx" ON "TransportOrder"("type");

-- CreateIndex
CREATE INDEX "OrderField_orderId_idx" ON "OrderField"("orderId");

-- CreateIndex
CREATE INDEX "OrderField_missing_idx" ON "OrderField"("missing");

-- CreateIndex
CREATE UNIQUE INDEX "OrderField_orderId_key_key" ON "OrderField"("orderId", "key");

-- CreateIndex
CREATE INDEX "MissingField_orderId_idx" ON "MissingField"("orderId");

-- CreateIndex
CREATE INDEX "AiRequest_orderId_idx" ON "AiRequest"("orderId");

-- CreateIndex
CREATE INDEX "AiRequest_status_idx" ON "AiRequest"("status");

-- CreateIndex
CREATE INDEX "XmlDelivery_orderId_idx" ON "XmlDelivery"("orderId");

-- CreateIndex
CREATE INDEX "XmlDelivery_status_idx" ON "XmlDelivery"("status");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportOrder" ADD CONSTRAINT "TransportOrder_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderField" ADD CONSTRAINT "OrderField_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingField" ADD CONSTRAINT "MissingField_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XmlDelivery" ADD CONSTRAINT "XmlDelivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

