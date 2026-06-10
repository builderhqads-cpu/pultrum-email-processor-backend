import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ConfigService } from '@nestjs/config';
import {
  MailProvider,
  NormalizedAttachment,
  NormalizedEmail,
} from './mail-provider.interface';
import { fetchAccessTokenFromRefreshToken } from '../oauth2/oauth2-refresh-token';

export class ImapMailProvider implements MailProvider {
  constructor(private readonly configService: ConfigService) {}

  private obfuscateEmail(email: string) {
    const at = email.indexOf('@');
    if (at <= 1) return '***';
    return `${email.slice(0, 2)}***${email.slice(at)}`;
  }

  private getConfig() {
    const host = (this.configService.get<string>('IMAP_HOST') || '').trim();
    const port = Number(this.configService.get('IMAP_PORT', 993));
    const secureRaw = (
      this.configService.get<string>('IMAP_SECURE') || 'true'
    ).trim();
    const secure = secureRaw === 'true' || secureRaw === '1';
    const user = (this.configService.get<string>('IMAP_USER') || '').trim();
    const rawPass = this.configService.get<string>('IMAP_PASSWORD') || '';
    // Microsoft app passwords are often copied with spaces; strip whitespace.
    const pass = rawPass.replace(/\s+/g, '');
    const loginMethod = (
      this.configService.get<string>('IMAP_LOGIN_METHOD') || ''
    )
      .trim()
      .toUpperCase();

    const authTypeRaw = (
      this.configService.get<string>('IMAP_AUTH_TYPE') || 'password'
    )
      .trim()
      .toLowerCase();
    const authType =
      authTypeRaw === 'xoauth2' || authTypeRaw === 'oauth2'
        ? 'xoauth2'
        : 'password';

    const accessTokenRaw =
      this.configService.get<string>('IMAP_ACCESS_TOKEN') || '';
    const accessToken = accessTokenRaw.replace(/\s+/g, '');

    const oauthProvider = (
      this.configService.get<string>('IMAP_OAUTH2_PROVIDER') || ''
    )
      .trim()
      .toLowerCase();

    const oauthTenantId =
      (this.configService.get<string>('IMAP_OAUTH2_TENANT_ID') || '').trim() ||
      (this.configService.get<string>('MS_TENANT_ID') || '').trim() ||
      'common';

    const oauthTokenEndpointExplicit = (
      this.configService.get<string>('IMAP_OAUTH2_TOKEN_ENDPOINT') || ''
    ).trim();
    const oauthTokenEndpoint =
      oauthTokenEndpointExplicit ||
      (oauthProvider === 'microsoft'
        ? `https://login.microsoftonline.com/${oauthTenantId}/oauth2/v2.0/token`
        : oauthProvider === 'google'
          ? 'https://oauth2.googleapis.com/token'
          : '');

    const oauthClientId =
      (this.configService.get<string>('IMAP_OAUTH2_CLIENT_ID') || '').trim() ||
      (oauthProvider === 'microsoft'
        ? (this.configService.get<string>('MS_CLIENT_ID') || '').trim()
        : '');

    const oauthClientSecret =
      (
        this.configService.get<string>('IMAP_OAUTH2_CLIENT_SECRET') || ''
      ).trim() ||
      (oauthProvider === 'microsoft'
        ? (this.configService.get<string>('MS_CLIENT_SECRET') || '').trim()
        : '');

    const oauthRefreshToken = (
      this.configService.get<string>('IMAP_OAUTH2_REFRESH_TOKEN') || ''
    ).trim();
    const oauthScope = (
      this.configService.get<string>('IMAP_OAUTH2_SCOPE') || ''
    ).trim();

    const oauthRedirectUri =
      (
        this.configService.get<string>('IMAP_OAUTH2_REDIRECT_URI') || ''
      ).trim() ||
      (oauthProvider === 'microsoft'
        ? (this.configService.get<string>('MS_REDIRECT_URI') || '').trim()
        : '');

    return {
      host,
      port,
      secure,
      user,
      pass,
      loginMethod,
      authType,
      accessToken,
      oauthProvider,
      oauthTokenEndpoint,
      oauthClientId,
      oauthClientSecret,
      oauthRefreshToken,
      oauthScope,
      oauthRedirectUri,
    };
  }

  private async resolveAccessToken(
    config: ReturnType<ImapMailProvider['getConfig']>,
  ) {
    if (config.accessToken) return config.accessToken;
    if (!config.oauthRefreshToken) {
      throw new Error(
        'IMAP XOAUTH2 is not configured. Set IMAP_ACCESS_TOKEN or IMAP_OAUTH2_REFRESH_TOKEN (+ client settings).',
      );
    }
    if (!config.oauthTokenEndpoint) {
      throw new Error(
        'IMAP XOAUTH2 is not configured. Set IMAP_OAUTH2_TOKEN_ENDPOINT or IMAP_OAUTH2_PROVIDER (microsoft|google).',
      );
    }
    if (!config.oauthClientId) {
      throw new Error(
        'IMAP XOAUTH2 is not configured. Set IMAP_OAUTH2_CLIENT_ID.',
      );
    }

    const res = await fetchAccessTokenFromRefreshToken({
      tokenEndpoint: config.oauthTokenEndpoint,
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret || undefined,
      refreshToken: config.oauthRefreshToken,
      scope: config.oauthScope || undefined,
      redirectUri: config.oauthRedirectUri || undefined,
    });
    return res.accessToken.replace(/\s+/g, '');
  }

  async syncInbox(limit = 10): Promise<NormalizedEmail[]> {
    if (limit <= 0) return [];

    const config = this.getConfig();
    const { host, port, secure, user, pass, loginMethod, authType } = config;
    if (!host || !user) {
      throw new Error('IMAP is not configured. Set IMAP_HOST and IMAP_USER.');
    }

    const auth: any = { user };
    if (authType === 'xoauth2') {
      auth.accessToken = await this.resolveAccessToken(config);
    } else {
      if (!pass) {
        throw new Error(
          'IMAP is not configured. Set IMAP_PASSWORD or switch IMAP_AUTH_TYPE=xoauth2.',
        );
      }
      auth.pass = pass;
      if (loginMethod) auth.loginMethod = loginMethod;
    }

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: {
        ...auth,
      },
    });

    try {
      await client.connect();
    } catch (err: any) {
      const responseText = String(
        err?.responseText || err?.response || err?.message || '',
      );
      const authenticationFailed =
        !!err?.authenticationFailed ||
        /AUTHENTICATE failed/i.test(responseText);

      if (authenticationFailed) {
        const methodLabel =
          authType === 'xoauth2'
            ? 'xoauth2 (accessToken)'
            : `password (${loginMethod || 'auto'})`;

        const hints: string[] = [];
        if (authType !== 'xoauth2') {
          hints.push(
            'Confirme se IMAP_USER/IMAP_PASSWORD estão corretos (use App Password se 2FA estiver ativo).',
          );
          if (!loginMethod) {
            hints.push(
              'Tente definir IMAP_LOGIN_METHOD=LOGIN (ou AUTH=LOGIN).',
            );
          }
          if (host === 'outlook.office365.com') {
            hints.push(
              'Se for Outlook.com/Hotmail, tente IMAP_HOST=imap-mail.outlook.com (porta 993, TLS).',
            );
          }
          hints.push(
            'Se a Microsoft estiver bloqueando “basic auth”, IMAP com senha pode falhar e só OAuth2/XOAUTH2 resolve.',
          );
        } else {
          hints.push(
            'Verifique se o access token é válido e tem permissão de IMAP (ex.: IMAP.AccessAsUser.All).',
          );
        }

        const printableUser = this.obfuscateEmail(user);
        throw new Error(
          [
            `IMAP authentication failed using ${methodLabel}.`,
            `Host=${host}:${port} Secure=${secure} User=${printableUser}`,
            responseText ? `Server: ${responseText}` : '',
            hints.length ? `Hints: ${hints.join(' ')}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
      }

      throw err;
    }

    const lock = await client.getMailboxLock('INBOX');
    try {
      const emails: NormalizedEmail[] = [];

      const mailbox = client.mailbox;
      if (!mailbox) return [];
      const exists = Number(mailbox.exists || 0);
      if (exists <= 0) return [];

      // Fetch the most recent `limit` messages using a standard sequence range.
      const startSeq = Math.max(1, exists - limit + 1);
      const range = `${startSeq}:${exists}`;

      for await (const message of client.fetch(range, {
        uid: true,
        envelope: true,
        internalDate: true,
        source: true,
      })) {
        const parsed = await simpleParser(message.source);
        const from = parsed.from?.value?.[0];
        const headers = parsed.headers as Map<string, any> | undefined;

        const messageIdHeader =
          (parsed.messageId as any) ||
          (headers?.get('message-id') as any) ||
          undefined;
        const inReplyToHeader =
          (headers?.get('in-reply-to') as any) || undefined;
        const referencesHeader =
          (headers?.get('references') as any) || undefined;

        const normalizeHeaderValue = (v: any) => {
          if (v == null) return undefined;
          if (Array.isArray(v))
            return v.filter(Boolean).join(' ').trim() || undefined;
          return v.toString().trim() || undefined;
        };

        const attachments: NormalizedAttachment[] = (
          parsed.attachments || []
        ).map((a, idx) => ({
          providerAttachmentId: a.partId || String(idx),
          fileName: a.filename || `attachment-${idx + 1}`,
          mimeType: a.contentType,
          size: a.size,
          contentBase64: a.content ? a.content.toString('base64') : undefined,
        }));

        emails.push({
          provider: 'imap',
          providerMessageId: String(message.uid),
          conversationId: parsed.messageId || undefined,
          messageIdHeader: normalizeHeaderValue(messageIdHeader),
          inReplyToHeader: normalizeHeaderValue(inReplyToHeader),
          referencesHeader: normalizeHeaderValue(referencesHeader),
          threadKey: normalizeHeaderValue(parsed.messageId || undefined),
          fromEmail: from?.address || '',
          fromName: from?.name || undefined,
          subject: parsed.subject || '',
          bodyText: parsed.text || undefined,
          bodyHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
          rawMimeBase64: Buffer.isBuffer(message.source)
            ? message.source.toString('base64')
            : undefined,
          rawMimeFileName: parsed.subject
            ? `${parsed.subject}.eml`
            : `message-${String(message.uid)}.eml`,
          rawMimeMimeType: 'message/rfc822',
          receivedAt:
            parsed.date || (message.internalDate as Date) || new Date(),
          hasAttachments: attachments.length > 0,
          attachments: attachments.length ? attachments : undefined,
        });
      }

      return emails;
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  }
}
