CREATE TABLE "MicrosoftConnection" (
    "id" TEXT NOT NULL DEFAULT 'microsoft',
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "providerAccountId" TEXT,
    "tenantId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicrosoftConnection_email_key" ON "MicrosoftConnection"("email");
