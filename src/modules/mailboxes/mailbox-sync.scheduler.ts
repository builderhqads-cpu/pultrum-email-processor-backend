import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { MailSyncService } from './mail-sync.service';

@Injectable()
export class MailboxSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(MailboxSyncScheduler.name);
  private running = false;
  private intervalName = 'mailbox-auto-sync';

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prismaService: PrismaService,
    private readonly mailSyncService: MailSyncService,
    private readonly systemSettingsService: SystemSettingsService,
  ) {}

  private intervalSeconds() {
    const raw = (this.configService.get<string>('MAILBOX_SYNC_INTERVAL_SECONDS') ?? '')
      .trim();
    const parsed = Number.parseInt(raw || '60', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 60;
    return parsed;
  }

  onModuleInit() {
    const seconds = this.intervalSeconds();
    const ms = seconds * 1000;

    // Ensure idempotent registration (hot reload / tests).
    try {
      this.schedulerRegistry.deleteInterval(this.intervalName);
    } catch {
      // ignore if not registered
    }

    const interval = setInterval(() => {
      void this.runOnce();
    }, ms);

    this.schedulerRegistry.addInterval(this.intervalName, interval);

    this.logger.log(
      `Mailbox auto-sync scheduler started. Interval=${seconds}s (gated by SystemSettings.syncMode)`,
    );

    // Kick off an initial run shortly after boot
    setTimeout(() => void this.runOnce(), 2_000).unref?.();
  }

  private async runOnce() {
    // Source of truth is the DB setting (editable at runtime from Settings).
    const enabled = await this.systemSettingsService
      .isAutoSyncEnabled()
      .catch(() => false);
    if (!enabled) {
      return; // sync mode is MANUAL
    }

    if (this.running) {
      this.logger.warn('Mailbox auto-sync skipped (previous run still running)');
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      const mailboxes = await this.prismaService.mailbox.findMany({
        where: { active: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!mailboxes.length) {
        this.logger.log('Mailbox auto-sync: no active mailboxes');
        return;
      }

      for (const mailbox of mailboxes) {
        const label = mailbox.email || mailbox.id;
        try {
          const res = await this.mailSyncService.syncMailbox(mailbox);

          await this.prismaService.mailbox.update({
            where: { id: mailbox.id },
            data: { lastSyncedAt: new Date() },
          });

          this.logger.log(
            `Mailbox auto-sync ok: email=${label} imported=${res.imported} skipped=${res.skipped} provider=${res.provider}`,
          );
        } catch (err: any) {
          this.logger.error(
            `Mailbox auto-sync failed: email=${label} error=${err?.message ?? String(err)}`,
            err?.stack,
          );
        }
      }
    } finally {
      this.running = false;
      const elapsedMs = Date.now() - startedAt;
      this.logger.log(`Mailbox auto-sync finished in ${elapsedMs}ms`);
    }
  }
}

