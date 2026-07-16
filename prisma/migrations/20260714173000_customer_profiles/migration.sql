-- CreateEnumValue
ALTER TYPE "OrderFieldSource" ADD VALUE IF NOT EXISTS 'CUSTOMER_PROFILE';

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfileField" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfileField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_contactEmail_key" ON "CustomerProfile"("contactEmail");

-- CreateIndex
CREATE INDEX "CustomerProfile_active_idx" ON "CustomerProfile"("active");

-- CreateIndex
CREATE INDEX "CustomerProfile_contactEmail_idx" ON "CustomerProfile"("contactEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfileField_profileId_key_key" ON "CustomerProfileField"("profileId", "key");

-- CreateIndex
CREATE INDEX "CustomerProfileField_profileId_idx" ON "CustomerProfileField"("profileId");

-- CreateIndex
CREATE INDEX "CustomerProfileField_key_idx" ON "CustomerProfileField"("key");

-- AddForeignKey
ALTER TABLE "CustomerProfileField" ADD CONSTRAINT "CustomerProfileField_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
