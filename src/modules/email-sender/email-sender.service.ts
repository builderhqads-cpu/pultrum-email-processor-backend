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
  signature?: string | null;
  // Original inbound message to thread against (stored as "graph:<id>").
  replyToGraphMessageId?: string | null;
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

  private composeBody(input: SendEmailInput) {
    const body = (input.body || '').toString();
    const signature = (input.signature || '').toString().trim();
    return signature ? `${body}\n\n${signature}` : body;
  }

  // Stored as "graph:<id>" / "imap:<id>". Only graph messages can be replied to
  // natively via Graph; returns the raw id or null.
  private toGraphMessageId(stored?: string | null): string | null {
    const v = (stored || '').toString().trim();
    if (!v) return null;
    if (v.startsWith('graph:')) return v.slice('graph:'.length);
    if (v.startsWith('imap:')) return null;
    return v;
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

    const replyTo = input.replyTo
      ? [{ emailAddress: { address: input.replyTo } }]
      : undefined;

    // Thread the reply natively. Graph rejects RFC headers (In-Reply-To /
    // References) on sendMail, so we reply to the original message instead —
    // this inherits the conversation and sets threading headers correctly.
    const replyId = this.toGraphMessageId(input.replyToGraphMessageId);
    if (replyId) {
      try {
        const draft = (await client
          .api(`/me/messages/${encodeURIComponent(replyId)}/createReply`)
          .post({})) as { id?: string };
        if (draft?.id) {
          await client.api(`/me/messages/${encodeURIComponent(draft.id)}`).patch({
            subject: input.subject,
            body: { contentType: 'Text', content: this.composeBody(input) },
            toRecipients: [{ emailAddress: { address: input.toEmail } }],
            ...(replyTo ? { replyTo } : {}),
          });
          await client
            .api(`/me/messages/${encodeURIComponent(draft.id)}/send`)
            .post({});
          return {
            ok: true,
            mocked: false,
            provider: 'graph',
            messageId: draft.id,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Graph createReply failed (${err?.message ?? err}); sending a standalone message instead.`,
        );
      }
    }

    // Fallback: standalone message (no RFC threading headers — Graph rejects them).
    await client.api('/me/sendMail').post({
      message: {
        subject: input.subject,
        body: { contentType: 'Text', content: this.composeBody(input) },
        toRecipients: [{ emailAddress: { address: input.toEmail } }],
        ...(replyTo ? { replyTo } : {}),
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
      text: this.composeBody(input),
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
