-- CreateTable
CREATE TABLE "CustomerProfileEmail" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfileEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfileEmail_email_key" ON "CustomerProfileEmail"("email");

-- CreateIndex
CREATE INDEX "CustomerProfileEmail_profileId_idx" ON "CustomerProfileEmail"("profileId");

-- AddForeignKey
ALTER TABLE "CustomerProfileEmail" ADD CONSTRAINT "CustomerProfileEmail_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
