# Pultrum — Mail Processor (backend)

NestJS service that turns transport-order emails into validated XML bookings.
It syncs shared mailboxes (Microsoft Graph / IMAP), uses AI to separate transport
orders from noise, extracts booking fields from the body **and** attachments
(DOCX / XLSX / PDF, with OCR), validates them, and delivers a structured XML to the
carrier backend (Creative Gears) — with a full audit trail.

Part of the **Pultrum** platform by **RenovoIA**. The operator UI lives in a
separate `pultrum-frontend` project.

## Stack

- **NestJS 11** (REST API + background workers)
- **Prisma** + **PostgreSQL**
- **BullMQ** + **Redis** (job queues)
- **Microsoft Graph** / **IMAP** (mailbox access)
- **OpenRouter** (AI extraction/classification/reply + OCR)

## Pipeline

```
Mailbox sync → AI classification gate → attachment extraction (+OCR)
→ extraction pipeline (regex + labels + AI → merge) → required-fields check
→ validation (confidence) → XML build → delivery to Creative Gears
```

Automation is configured at runtime (Settings → Automation, persisted in the
`SystemSettings` table): sync is Manual/Automatic; delivery is
Manual/Selective/Autonomous. AI never drops or auto-sends on failure — it fails
open to the human queue.

## Local development

```bash
cp .env.example .env          # fill in OPENROUTER_API_KEY, MS_* etc.
npm install
docker compose up -d          # Postgres, Redis, pgAdmin
npx prisma migrate deploy
npm run prisma:seed           # admin user + mailboxes
npm run start:dev             # http://localhost:3000
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run start:dev` | API in watch mode |
| `npm run start:prod` | Run compiled API (`dist/main`) |
| `npm run build` | Compile |
| `npm test` | Unit tests |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run prisma:seed` | Seed admin user + mailboxes |

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full annotated list. Key groups: database, Redis, Microsoft Graph OAuth,
OpenRouter (AI/OCR), Creative Gears delivery, and the admin seed.

## Deployment

Containerized deployment to a VPS (Hostinger) with Docker Compose + Nginx +
Let's Encrypt is documented in **[DEPLOY.md](DEPLOY.md)**.

## License

[MIT](LICENSE) © RenovoIA.
