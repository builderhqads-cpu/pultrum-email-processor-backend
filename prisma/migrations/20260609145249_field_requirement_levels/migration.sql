-- CreateEnum
CREATE TYPE "FieldRequirement" AS ENUM ('REQUIRED', 'RECOMMENDED', 'OPTIONAL');

-- AlterTable
ALTER TABLE "MissingField" ADD COLUMN     "requirement" "FieldRequirement" NOT NULL DEFAULT 'REQUIRED';

-- AlterTable
ALTER TABLE "OrderField" ADD COLUMN     "requirement" "FieldRequirement" NOT NULL DEFAULT 'OPTIONAL';

-- CreateTable
CREATE TABLE "ValidationWarning" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requirement" "FieldRequirement" NOT NULL DEFAULT 'RECOMMENDED',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationWarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValidationWarning_orderId_idx" ON "ValidationWarning"("orderId");

-- CreateIndex
CREATE INDEX "ValidationWarning_requirement_idx" ON "ValidationWarning"("requirement");

-- AddForeignKey
ALTER TABLE "ValidationWarning" ADD CONSTRAINT "ValidationWarning_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
