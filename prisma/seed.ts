import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const prisma = new PrismaClient();

  const adminEmail =
    process.env.ADMIN_EMAIL?.trim().toLowerCase() || 'admin@renovoia.local';
  const adminPassword = process.env.ADMIN_PASSWORD?.trim() || 'admin123';
  const adminName = process.env.ADMIN_NAME?.trim() || 'Admin';

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash,
      role: UserRole.ADMIN,
      active: true,
    },
    update: {
      name: adminName,
      passwordHash,
      role: UserRole.ADMIN,
      active: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seed: admin user ready (${adminEmail})`);

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
