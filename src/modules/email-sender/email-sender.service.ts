import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { GraphAuthService } from '../graph/graph-auth.service';

export type SendEmailInput = {
  mailboxEmail?: string | null;
  toEmail: string;
  subject: string;
  body: string;
  replyTo?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
};

export type SendEmailResult = {
  ok: boolean;
  mocked: boolean;
  provider: 'graph' | 'smtp';
  messageId?: string | null;
};

@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly graphAuthService: GraphAuthService,
  ) {}

  private getSendProvider() {
    const provider = (
      this.configService.get<string>('EMAIL_SEND_PROVIDER') || 'graph'
    )
      .trim()
      .toLowerCase();

    return provider === 'smtp' ? 'smtp' : 'graph';
  }

  private getConfig() {
    const host = (this.configService.get<string>('SMTP_HOST') || '').trim();
    const port = Number(this.configService.get<string>('SMTP_PORT') || '');
    const secureRaw = (this.configService.get<string>('SMTP_SECURE') || '')
      .trim()
      .toLowerCase();
    const secure = ['1', 'true', 'yes', 'y', 'on'].includes(secureRaw);
    const user = (this.configService.get<string>('SMTP_USER') || '').trim();
    const password = this.configService.get<string>('SMTP_PASSWORD') || '';

    const fromName =
      (this.configService.get<string>('SMTP_FROM_NAME') || '').trim() ||
      'RENOVO IA';
    const fromEmail = (
      this.configService.get<string>('SMTP_FROM_EMAIL') || ''
    ).trim();
    const replyTo = (
      this.configService.get<string>('SMTP_REPLY_TO') || ''
    ).trim();

    return { host, port, secure, user, password, fromName, fromEmail, replyTo };
  }

  private isConfigured(config: ReturnType<EmailSenderService['getConfig']>) {
    return Boolean(
      config.host &&
      config.port &&
      Number.isFinite(config.port) &&
      config.fromEmail,
    );
  }

  private async sendViaGraph(
    mailboxEmail: string,
    input: SendEmailInput,
  ): Promise<SendEmailResult> {
    const storedScopes =
      await this.graphAuthService.getMailboxStoredScopes(mailboxEmail);
    if (!storedScopes || !storedScopes.split(/\s+/).includes('Mail.Send')) {
      throw new Error(
        `Mailbox ${mailboxEmail} must be reconnected in Microsoft Graph to grant Mail.Send.`,
      );
    }

    const client =
      await this.graphAuthService.getAuthenticatedClient(mailboxEmail);

    await client.api('/me/sendMail').post({
      message: {
        subject: input.subject,
        body: {
          contentType: 'Text',
          content: input.body,
        },
        toRecipients: [
          {
            emailAddress: {
              address: input.toEmail,
            },
          },
        ],
        ...(input.replyTo
          ? {
              replyTo: [
                {
                  emailAddress: {
                    address: input.replyTo,
                  },
                },
              ],
            }
          : {}),
        ...(input.inReplyTo || input.references
          ? {
              internetMessageHeaders: [
                ...(input.inReplyTo
                  ? [{ name: 'In-Reply-To', value: input.inReplyTo }]
                  : []),
                ...(input.references
                  ? [{ name: 'References', value: input.references }]
                  : []),
              ],
            }
          : {}),
      },
      saveToSentItems: true,
    });

    return { ok: true, mocked: false, provider: 'graph', messageId: null };
  }

  private async sendViaSmtp(input: SendEmailInput): Promise<SendEmailResult> {
    const cfg = this.getConfig();
    if (!this.isConfigured(cfg)) {
      this.logger.warn(
        `SMTP not configured; mocked send to=${input.toEmail} subject=${input.subject}`,
      );
      return { ok: true, mocked: true, provider: 'smtp', messageId: null };
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    });

    const from = cfg.fromName
      ? `${cfg.fromName} <${cfg.fromEmail}>`
      : cfg.fromEmail;

    const info = await transporter.sendMail({
      from,
      to: input.toEmail,
      subject: input.subject,
      text: input.body,
      ...(input.replyTo || cfg.replyTo
        ? { replyTo: input.replyTo || cfg.replyTo }
        : {}),
      headers: {
        ...(input.inReplyTo ? { 'In-Reply-To': input.inReplyTo } : {}),
        ...(input.references ? { References: input.references } : {}),
      },
    });

    return {
      ok: true,
      mocked: false,
      provider: 'smtp',
      messageId: info.messageId ?? null,
    };
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const provider = this.getSendProvider();

    if (provider === 'graph' && !input.mailboxEmail) {
      throw new Error(
        'Graph email sending requires a connected source mailbox.',
      );
    }

    if (provider === 'graph' && input.mailboxEmail) {
      return this.sendViaGraph(input.mailboxEmail, input);
    }

    return this.sendViaSmtp(input);
  }
}
