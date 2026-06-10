-- CreateEnum
CREATE TYPE "AttachmentExtractionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "extractionMethod" TEXT,
ADD COLUMN     "extractionStatus" "AttachmentExtractionStatus" NOT NULL DEFAULT 'PENDING';
