-- AlterTable
ALTER TABLE "EmailMessage"
ADD COLUMN     "rawMimeBase64" TEXT,
ADD COLUMN     "rawMimeFileName" TEXT,
ADD COLUMN     "rawMimeMimeType" TEXT;
