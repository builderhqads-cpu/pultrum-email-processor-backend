-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "xmlConfirmationBody" TEXT,
ADD COLUMN     "xmlConfirmationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "xmlConfirmationSubject" TEXT;
