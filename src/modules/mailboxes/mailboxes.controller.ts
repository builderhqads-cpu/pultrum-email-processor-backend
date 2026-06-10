import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Department } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailSyncService } from './mail-sync.service';
import { MailProviderFactory } from '../../mail/mail-provider.factory';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const mailboxSelect = {
  id: true,
  email: true,
  department: true,
  active: true,
  lastSyncedAt: true,
  graphConnectedEmail: true,
  graphDisplayName: true,
  graphTenantId: true,
  graphTokenExpiresAt: true,
  graphRefreshToken: true,
} as const;

type MailboxPayload = {
  email?: unknown;
  department?: unknown;
  active?: unknown;
};

@Controller('mailboxes')
@UseGuards(JwtAuthGuard)
export class MailboxesController {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailProviderFactory: MailProviderFactory,
    private readonly mailSyncService: MailSyncService,
  ) {}

  private mapMailbox(mailbox: {
    id: string;
    email: string;
    department: Department;
    active: boolean;
    lastSyncedAt: Date | null;
    graphConnectedEmail: string | null;
    graphDisplayName: string | null;
    graphTenantId: string | null;
    graphTokenExpiresAt: Date | null;
    graphRefreshToken: string | null;
  }) {
    return {
      id: mailbox.id,
      email: mailbox.email,
      department: mailbox.department,
      active: mailbox.active,
      lastSyncedAt: mailbox.lastSyncedAt,
      graphConnected: Boolean(mailbox.graphConnectedEmail),
      graphConnectedEmail: mailbox.graphConnectedEmail,
      graphDisplayName: mailbox.graphDisplayName,
      graphTenantId: mailbox.graphTenantId,
      graphTokenExpiresAt: mailbox.graphTokenExpiresAt,
      graphHasRefreshToken: Boolean(mailbox.graphRefreshToken),
    };
  }

  private normalizeEmail(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Mailbox email is required.');
    }

    const email = value.trim().toLowerCase();
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isValidEmail) {
      throw new BadRequestException('Mailbox email is invalid.');
    }

    return email;
  }

  private parseDepartment(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Mailbox department is required.');
    }

    const department = value.trim().toUpperCase();
    if (department === Department.OPEN_TRANSPORT) {
      return Department.OPEN_TRANSPORT;
    }
    if (department === 'STUK_GOOD' || department === Department.STUK_GOED) {
      return Department.STUK_GOED;
    }

    throw new BadRequestException(
      'Mailbox department must be OPEN_TRANSPORT or STUK_GOED.',
    );
  }

  private parseActive(value: unknown) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException('Mailbox active must be a boolean.');
    }

    return value;
  }

  @Get()
  async findAll() {
    const mailboxes = await this.prismaService.mailbox.findMany({
      orderBy: { createdAt: 'asc' },
      select: mailboxSelect,
    });

    return mailboxes.map((mailbox) => this.mapMailbox(mailbox));
  }

  @Post()
  async createMailbox(@Body() body: MailboxPayload) {
    const email = this.normalizeEmail(body.email);
    const department = this.parseDepartment(body.department);
    const active =
      body.active === undefined ? true : this.parseActive(body.active);

    const existingMailbox = await this.prismaService.mailbox.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingMailbox) {
      throw new BadRequestException(
        'A mailbox with this email already exists.',
      );
    }

    const mailbox = await this.prismaService.mailbox.create({
      data: {
        email,
        department,
        active,
      },
      select: mailboxSelect,
    });

    return this.mapMailbox(mailbox);
  }

  @Patch(':id')
  async updateMailbox(@Param('id') id: string, @Body() body: MailboxPayload) {
    const existingMailbox = await this.prismaService.mailbox.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
      },
    });

    if (!existingMailbox) {
      throw new BadRequestException('Mailbox not found');
    }

    const data: {
      email?: string;
      department?: Department;
      active?: boolean;
      graphConnectedEmail?: null;
      graphDisplayName?: null;
      graphProviderAccountId?: null;
      graphTenantId?: null;
      graphAccessToken?: null;
      graphRefreshToken?: null;
      graphTokenExpiresAt?: null;
      graphScopes?: null;
    } = {};

    if (body.email !== undefined) {
      const email = this.normalizeEmail(body.email);
      if (email !== existingMailbox.email) {
        const conflictingMailbox = await this.prismaService.mailbox.findUnique({
          where: { email },
          select: { id: true },
        });
        if (conflictingMailbox && conflictingMailbox.id !== id) {
          throw new BadRequestException(
            'A mailbox with this email already exists.',
          );
        }

        data.email = email;
        data.graphConnectedEmail = null;
        data.graphDisplayName = null;
        data.graphProviderAccountId = null;
        data.graphTenantId = null;
        data.graphAccessToken = null;
        data.graphRefreshToken = null;
        data.graphTokenExpiresAt = null;
        data.graphScopes = null;
      }
    }

    if (body.department !== undefined) {
      data.department = this.parseDepartment(body.department);
    }

    if (body.active !== undefined) {
      data.active = this.parseActive(body.active);
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No mailbox updates were provided.');
    }

    const mailbox = await this.prismaService.mailbox.update({
      where: { id },
      data,
      select: mailboxSelect,
    });

    return this.mapMailbox(mailbox);
  }

  @Delete(':id')
  async deleteMailbox(@Param('id') id: string) {
    const mailbox = await this.prismaService.mailbox.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        _count: {
          select: {
            emailMessages: true,
          },
        },
      },
    });

    if (!mailbox) {
      throw new BadRequestException('Mailbox not found');
    }

    const ordersCount = await this.prismaService.transportOrder.count({
      where: {
        emailMessage: {
          mailboxId: id,
        },
      },
    });

    await this.prismaService.mailbox.delete({
      where: { id },
    });

    return {
      ok: true,
      deletedMailboxId: mailbox.id,
      deletedMailboxEmail: mailbox.email,
      deletedEmailsCount: mailbox._count.emailMessages,
      deletedOrdersCount: ordersCount,
    };
  }

  @Post(':id/sync')
  async syncMailbox(@Param('id') id: string) {
    const mailbox = await this.prismaService.mailbox.findUnique({
      where: { id },
    });

    if (!mailbox) {
      throw new BadRequestException('Mailbox not found');
    }
    if (!mailbox.active) {
      throw new BadRequestException('Mailbox is not active');
    }

    if (this.mailProviderFactory.getConfiguredProvider() === 'imap') {
      const configuredEmail = (
        this.configService.get<string>('IMAP_USER') || ''
      ).trim();
      if (!configuredEmail) {
        throw new BadRequestException(
          'IMAP_USER is required when MAIL_PROVIDER=imap',
        );
      }
      if (configuredEmail.toLowerCase() !== mailbox.email.toLowerCase()) {
        throw new BadRequestException(
          `When MAIL_PROVIDER=imap, mailbox.email must match IMAP_USER (${configuredEmail}).`,
        );
      }
    } else if (!mailbox.graphConnectedEmail) {
      throw new BadRequestException(
        `Mailbox ${mailbox.email} is not connected to Microsoft Graph.`,
      );
    }

    const result = await this.mailSyncService.syncMailbox(mailbox);

    await this.prismaService.mailbox.update({
      where: { id: mailbox.id },
      data: { lastSyncedAt: new Date() },
    });

    return result;
  }
}
