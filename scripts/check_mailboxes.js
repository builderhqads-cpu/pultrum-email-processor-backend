const fs = require("node:fs");
const path = require("node:path");

function loadDatabaseUrl() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "DATABASE_URL") return val;
  }
  return null;
}

async function main() {
  const db = loadDatabaseUrl();
  if (db && !process.env.DATABASE_URL) process.env.DATABASE_URL = db;

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  const emails = [
    "planning@pultrum-rijssen.nl",
    "stukgoed@pultrum-rijssen.nl",
    "recard27@hotmail.com",
  ];

  const rows = await prisma.mailbox.findMany({
    where: { email: { in: emails } },
    select: { email: true, department: true, active: true, createdAt: true },
    orderBy: { email: "asc" },
  });

  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

