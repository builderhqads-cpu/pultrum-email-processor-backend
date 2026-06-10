import {
  BadRequestException,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Department } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailProviderFactory } from '../../mail/mail-provider.factory';
import { MailSyncService } from './mail-sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('mailbox')
@UseGuards(JwtAuthGuard)
export class MailboxController {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailProviderFactory: MailProviderFactory,
    private readonly mailSyncService: MailSyncService,
  ) {}

  private getImapDepartment(): Department {
    const raw = (
      this.configService.get<string>('IMAP_MAILBOX_DEPARTMENT') ||
      'OPEN_TRANSPORT'
    )
      .trim()
      .toUpperCase();
    return raw === 'STUK_GOED'
      ? Department.STUK_GOED
      : Department.OPEN_TRANSPORT;
  }

  private getImapAutoCreateMailbox(): boolean {
    const raw = (
      this.configService.get<string>('IMAP_AUTO_CREATE_MAILBOX') || 'false'
    )
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  @Post('sync')
  async sync() {
    const provider = this.mailProviderFactory.getConfiguredProvider();

    if (provider === 'imap') {
      const email = (this.configService.get<string>('IMAP_USER') || '').trim();
      if (!email) {
        throw new BadRequestException(
          'IMAP_USER is required when MAIL_PROVIDER=imap',
        );
      }

      let mailbox = await this.prismaService.mailbox.findUnique({
        where: { email },
      });

      if (!mailbox) {
        if (this.getImapAutoCreateMailbox()) {
          mailbox = await this.prismaService.mailbox.create({
            data: {
              email,
              department: this.getImapDepartment(),
              active: true,
            },
          });
        } else {
          throw new BadRequestException(
            `Mailbox not found for IMAP_USER=${email}. Create it in DB, set IMAP_AUTO_CREATE_MAILBOX=true, or adjust IMAP_USER.`,
          );
        }
      }
      if (!mailbox.active) {
        throw new BadRequestException('Mailbox is not active');
      }

      const result = await this.mailSyncService.syncMailbox(mailbox);
      await this.prismaService.mailbox.update({
        where: { id: mailbox.id },
        data: { lastSyncedAt: new Date() },
      });

      return result;
    }

    // graph: sync all active mailboxes in DB
    const mailboxes = await this.prismaService.mailbox.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });

    let imported = 0;
    let skipped = 0;
    const emails: Array<{ emailMessageId: string; providerMessageId: string }> =
      [];

    for (const mailbox of mailboxes) {
      const res = await this.mailSyncService.syncMailbox(mailbox);
      imported += res.imported;
      skipped += res.skipped;
      emails.push(...res.emails);
      await this.prismaService.mailbox.update({
        where: { id: mailbox.id },
        data: { lastSyncedAt: new Date() },
      });
    }

    return { provider, imported, skipped, emails };
  }
}
