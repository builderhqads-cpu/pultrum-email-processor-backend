/**
 * DEV-ONLY: ingest a local .eml file into the running stack, exactly as if it
 * had arrived in the mailbox — so you can test the pipeline (AI extraction ->
 * orders -> opdrachtgever profile resolution -> XML) without IMAP/Graph.
 *
 * It parses the .eml, stores it as an EmailMessage (+ attachments) with the raw
 * MIME in rawMimeBase64 (the same bytes the AI router receives), then enqueues
 * the 'process-email' job. The running backend worker does the rest.
 *
 * Usage (backend + postgres/redis must be up; run from the backend repo):
 *   npm run ingest:eml -- ../eml/some-order.eml
 *   npm run ingest:eml -- ../eml            # a folder: ingests every *.eml
 *
 * Needs DATABASE_URL + REDIS_HOST/PORT (loaded from .env).
 */
import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PrismaClient, Department, EmailStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { simpleParser } from 'mailparser';

const DEV_MAILBOX_EMAIL = 'dev-ingest@local.test';

function collectEmlPaths(arg: string): string[] {
  const p = resolve(arg);
  if (statSync(p).isDirectory()) {
    return readdirSync(p)
      .filter((f) => f.toLowerCase().endsWith('.eml'))
      .map((f) => join(p, f));
  }
  return [p];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: npm run ingest:eml -- <file.eml | folder> [more.eml ...]',
    );
    process.exit(1);
  }

  const paths = args.flatMap(collectEmlPaths);
  if (paths.length === 0) {
    console.error('No .eml files found.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const queue = new Queue('email-processing', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
    },
  });

  // A dev mailbox to hang the messages on (OPEN_TRANSPORT = active pipeline).
  const mailbox = await prisma.mailbox.upsert({
    where: { email: DEV_MAILBOX_EMAIL },
    update: { active: true },
    create: {
      email: DEV_MAILBOX_EMAIL,
      department: Department.OPEN_TRANSPORT,
      active: true,
    },
    select: { id: true, email: true },
  });

  for (const path of paths) {
    const base = basename(path);
    const raw = readFileSync(path);
    const parsed = await simpleParser(raw);

    const from = parsed.from?.value?.[0];
    // Drop inline (cid) signature/logo images, like Graph ingestion does.
    const attachments = (parsed.attachments ?? []).filter((a) => !a.related);

    const stamp = Date.now();
    const providerId = `local-eml:${base}:${stamp}`;

    const email = await prisma.emailMessage.create({
      data: {
        mailboxId: mailbox.id,
        graphMessageId: providerId,
        conversationId: providerId,
        fromEmail: from?.address || 'unknown@local.test',
        fromName: from?.name || '',
        subject: parsed.subject || base,
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
        rawMimeBase64: raw.toString('base64'),
        rawMimeFileName: base,
        rawMimeMimeType: 'message/rfc822',
        receivedAt: parsed.date ?? new Date(),
        hasAttachments: attachments.length > 0,
        status: EmailStatus.RECEIVED,
        attachments: attachments.length
          ? {
              create: attachments.map((a, idx) => ({
                graphAttachmentId: `${idx + 1}:${a.filename ?? 'file'}`,
                fileName: a.filename || `attachment-${idx + 1}`,
                mimeType: a.contentType || 'application/octet-stream',
                size: a.size ?? a.content?.length ?? 0,
                contentBase64: a.content
                  ? Buffer.from(a.content).toString('base64')
                  : null,
              })),
            }
          : undefined,
      },
      select: { id: true, graphMessageId: true },
    });

    await queue.add('process-email', {
      emailMessageId: email.id,
      graphMessageId: email.graphMessageId,
    });

    console.log(
      `queued ${base}: emailMessageId=${email.id} from=${from?.address ?? '?'} attachments=${attachments.length}`,
    );
  }

  await queue.close();
  await prisma.$disconnect();
  console.log(
    `\nDone. Watch the backend logs and refresh the portal (Triage / Orders).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
