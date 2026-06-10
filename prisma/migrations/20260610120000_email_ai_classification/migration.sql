-- AlterTable
ALTER TABLE "EmailMessage"
ADD COLUMN     "isTransportOrder" BOOLEAN,
ADD COLUMN     "classificationReason" TEXT,
ADD COLUMN     "classificationLanguage" TEXT,
ADD COLUMN     "classifiedAt" TIMESTAMP(3);
