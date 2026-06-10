import { PrismaClient, Department, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const prisma = new PrismaClient();

  const openTransportMailbox =
    process.env.OPEN_TRANSPORT_MAILBOX?.trim() ||
    'planning@pultrum-rijssen.nl';
  const stukGoedMailbox =
    process.env.STUK_GOED_MAILBOX?.trim() || 'stukgoed@pultrum-rijssen.nl';
  const testMailbox =
    process.env.TEST_MAILBOX_EMAIL?.trim() || 'recard27@hotmail.com';

  await prisma.mailbox.upsert({
    where: { email: openTransportMailbox },
    create: {
      email: openTransportMailbox,
      department: Department.OPEN_TRANSPORT,
      active: true,
    },
    update: {
      department: Department.OPEN_TRANSPORT,
      active: true,
    },
  });

  await prisma.mailbox.upsert({
    where: { email: stukGoedMailbox },
    create: {
      email: stukGoedMailbox,
      department: Department.STUK_GOED,
      active: true,
    },
    update: {
      department: Department.STUK_GOED,
      active: true,
    },
  });

  await prisma.mailbox.upsert({
    where: { email: testMailbox },
    create: {
      email: testMailbox,
      department: Department.OPEN_TRANSPORT,
      active: true,
    },
    update: {
      department: Department.OPEN_TRANSPORT,
      active: true,
    },
  });

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

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
