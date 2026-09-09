-- CreateTable
CREATE TABLE "AiCallLog" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'eml-process',
    "status" TEXT NOT NULL,
    "error" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCallLog_createdAt_idx" ON "AiCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiCallLog_status_idx" ON "AiCallLog"("status");
