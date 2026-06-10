-- AlterTable
ALTER TABLE "Mailbox"
ADD COLUMN     "graphAccessToken" TEXT,
ADD COLUMN     "graphConnectedEmail" TEXT,
ADD COLUMN     "graphDisplayName" TEXT,
ADD COLUMN     "graphProviderAccountId" TEXT,
ADD COLUMN     "graphRefreshToken" TEXT,
ADD COLUMN     "graphScopes" TEXT,
ADD COLUMN     "graphTenantId" TEXT,
ADD COLUMN     "graphTokenExpiresAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "MicrosoftConnection";
