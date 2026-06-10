-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "syncMode" TEXT NOT NULL DEFAULT 'AUTOMATIC',
    "deliveryMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "autoXmlConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);
