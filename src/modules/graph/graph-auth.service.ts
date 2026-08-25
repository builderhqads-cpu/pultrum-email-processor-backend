import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@microsoft/microsoft-graph-client';
import { Department } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import 'isomorphic-fetch';

type OAuthTokenPayload = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
};

type MailboxTokenRecord = {
  email: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

type MicrosoftGraphProfile = {
  id?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
};

type GraphInboxMessagesResponse = {
  value?: unknown[];
};

@Injectable()
export class GraphAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {}

  private get tenantId() {
    return this.configService.get<string>('MS_TENANT_ID') || 'common';
  }

  private get clientId() {
    return this.configService.get<string>('MS_CLIENT_ID') || '';
  }

  private get clientSecret() {
    return this.configService.get<string>('MS_CLIENT_SECRET') || '';
  }

  private get redirectUri() {
    const explicit = this.configService.get<string>('MS_REDIRECT_URI');
    if (explicit) return explicit;
    const port = this.configService.get<string>('PORT', '3000');
    return `http://localhost:${port}/auth/callback`;
  }

  private get scopes() {
    return [
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      // Mail.ReadWrite (superset of Mail.Read) is required for Graph's native
      // createReply (draft creation) used to thread reply emails.
      'Mail.ReadWrite',
      'Mail.Send',
    ];
  }

  private get frontendSettingsUrl() {
    const explicit = (
      this.configService.get<string>('FRONTEND_SETTINGS_URL') || ''
    ).trim();
    if (explicit) return explicit;
    return 'http://localhost:3001/en/settings';
  }

  private get graphMailboxDepartment(): Department {
    const raw = (
      this.configService.get<string>('GRAPH_CONNECTED_MAILBOX_DEPARTMENT') ||
      'OPEN_TRANSPORT'
    )
      .trim()
      .toUpperCase();

    return raw === 'STUK_GOED'
      ? Department.STUK_GOED
      : Department.OPEN_TRANSPORT;
  }

  private get tokenEndpoint() {
    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
  }

  private createAuthenticatedClient(accessToken: string) {
    return Client.init({
      authProvider: (done) => done(null, accessToken),
    });
  }

  private async getMailboxTokenRecord(mailboxEmail: string) {
    return this.prismaService.mailbox.findUnique({
      where: { email: mailboxEmail },
      select: {
        id: true,
        email: true,
        graphScopes: true,
        graphAccessToken: true,
        graphRefreshToken: true,
        graphTokenExpiresAt: true,
      },
    });
  }

  async getMailboxStoredScopes(mailboxEmail: string) {
    const mailbox = await this.prismaService.mailbox.findUnique({
      where: { email: mailboxEmail },
      select: {
        graphScopes: true,
      },
    });

    return mailbox?.graphScopes ?? null;
  }

  private async refreshAccessTokenIfNeeded(
    record: MailboxTokenRecord,
  ): Promise<MailboxTokenRecord> {
    const expiresAt = record.expiresAt?.getTime() ?? 0;
    if (record.accessToken && Date.now() < expiresAt) {
      return record;
    }
    if (!record.refreshToken) {
      throw new Error(
        `Microsoft mailbox ${record.email} is not connected. Reconnect this mailbox.`,
      );
    }

    const body = new URLSearchParams();
    body.set('client_id', this.clientId);
    body.set('client_secret', this.clientSecret);
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', record.refreshToken);
    body.set('redirect_uri', this.redirectUri);
    body.set('scope', this.scopes.join(' '));

    const res = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = new Date(
      Date.now() + Math.max(0, (json.expires_in ?? 3600) - 30) * 1000,
    );

    await this.prismaService.mailbox.update({
      where: { email: record.email },
      data: {
        graphAccessToken: json.access_token,
        graphRefreshToken: json.refresh_token ?? record.refreshToken,
        graphTokenExpiresAt: newExpiresAt,
      },
    });

    return {
      email: record.email,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? record.refreshToken,
      expiresAt: newExpiresAt,
    };
  }

  /**
   * App-only (client-credentials) mode: the backend authenticates as the APP
   * itself — no interactive sign-in, no per-mailbox OAuth token, no shared-
   * mailbox Full Access needed. Reads a mailbox via /users/{mailbox} with an
   * Application-permission token. Enabled with GRAPH_APP_ONLY=true; requires a
   * real MS_TENANT_ID (not common/consumers), the client secret, and the app
   * granted Application permissions (Mail.Read/Mail.Send) + admin consent.
   */
  get appOnlyEnabled(): boolean {
    return ['1', 'true', 'yes', 'y', 'on'].includes(
      (this.configService.get<string>('GRAPH_APP_ONLY') ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  private appOnlyToken: { token: string; expiresAt: number } | null = null;

  private async getAppOnlyToken(): Promise<string> {
    if (this.appOnlyToken && Date.now() < this.appOnlyToken.expiresAt) {
      return this.appOnlyToken.token;
    }

    const body = new URLSearchParams();
    body.set('client_id', this.clientId);
    body.set('client_secret', this.clientSecret);
    body.set('grant_type', 'client_credentials');
    body.set('scope', 'https://graph.microsoft.com/.default');

    const res = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`App-only token request failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.appOnlyToken = {
      token: json.access_token,
      expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000,
    };
    return this.appOnlyToken.token;
  }

  async getAuthenticatedClient(mailboxEmail: string) {
    // App-only: authenticate as the app (client credentials), no per-mailbox
    // token or interactive sign-in required.
    if (this.appOnlyEnabled) {
      return this.createAuthenticatedClient(await this.getAppOnlyToken());
    }

    const record = await this.getMailboxTokenRecord(mailboxEmail);
    if (!record?.graphAccessToken) {
      throw new Error(
        `Mailbox ${mailboxEmail} is not connected to Microsoft Graph.`,
      );
    }

    const refreshed = await this.refreshAccessTokenIfNeeded({
      email: record.email,
      accessToken: record.graphAccessToken,
      refreshToken: record.graphRefreshToken,
      expiresAt: record.graphTokenExpiresAt,
    });

    return this.createAuthenticatedClient(refreshed.accessToken);
  }

  private async getCurrentAccountProfile(accessToken: string) {
    const client = this.createAuthenticatedClient(accessToken);
    const profile = (await client
      .api('/me')
      .select('id,displayName,mail,userPrincipalName')
      .get()) as MicrosoftGraphProfile;

    return {
      providerAccountId: profile.id ?? null,
      displayName: profile.displayName ?? null,
      email: profile.mail || profile.userPrincipalName || null,
    };
  }

  async persistMailboxConnection(mailboxId: string, tokens: OAuthTokenPayload) {
    const mailbox = await this.prismaService.mailbox.findUnique({
      where: { id: mailboxId },
      select: {
        id: true,
        email: true,
        department: true,
      },
    });

    if (!mailbox) {
      throw new Error('Mailbox not found for Microsoft OAuth.');
    }

    const profile = await this.getCurrentAccountProfile(tokens.accessToken);
    if (!profile.email) {
      throw new Error(
        'Microsoft account email could not be resolved from /me.',
      );
    }

    // The signed-in account does NOT have to BE the mailbox: a SHARED mailbox
    // (e.g. planning@) is connected by signing in as a user who has Full Access
    // to it. So instead of requiring account == mailbox, when they differ we
    // verify the signed-in account can actually READ the target mailbox.
    if (profile.email.toLowerCase() !== mailbox.email.toLowerCase()) {
      try {
        await this.createAuthenticatedClient(tokens.accessToken)
          .api(
            `/users/${encodeURIComponent(mailbox.email)}/mailFolders/inbox`,
          )
          .get();
      } catch {
        throw new Error(
          `The signed-in account ${profile.email} does not have access to mailbox ` +
            `${mailbox.email}. Sign in with an account that has Full Access to this ` +
            `(shared) mailbox, or sign in as the mailbox itself.`,
        );
      }
    }

    const expiresAt = new Date(
      Date.now() + Math.max(0, (tokens.expiresInSeconds ?? 3600) - 30) * 1000,
    );

    const updated = await this.prismaService.mailbox.update({
      where: { id: mailbox.id },
      data: {
        active: true,
        department: mailbox.department ?? this.graphMailboxDepartment,
        graphConnectedEmail: profile.email,
        graphDisplayName: profile.displayName,
        graphProviderAccountId: profile.providerAccountId,
        graphTenantId: this.tenantId,
        graphAccessToken: tokens.accessToken,
        graphRefreshToken: tokens.refreshToken ?? null,
        graphTokenExpiresAt: expiresAt,
        graphScopes: this.scopes.join(' '),
      },
      select: {
        id: true,
        email: true,
        department: true,
        graphConnectedEmail: true,
        graphDisplayName: true,
        graphTokenExpiresAt: true,
        graphTenantId: true,
        graphRefreshToken: true,
      },
    });

    return {
      connected: true,
      mailboxId: updated.id,
      mailboxEmail: updated.email,
      department: updated.department,
      email: updated.graphConnectedEmail,
      displayName: updated.graphDisplayName,
      expiresAt: updated.graphTokenExpiresAt?.toISOString() ?? null,
      tenantId: updated.graphTenantId ?? null,
      hasRefreshToken: Boolean(updated.graphRefreshToken),
    };
  }

  async getMailboxConnectionStatus(mailboxId: string) {
    const mailbox = await this.prismaService.mailbox.findUnique({
      where: { id: mailboxId },
      select: {
        id: true,
        email: true,
        department: true,
        graphConnectedEmail: true,
        graphDisplayName: true,
        graphTenantId: true,
        graphTokenExpiresAt: true,
        graphRefreshToken: true,
      },
    });

    if (!mailbox) {
      throw new Error('Mailbox not found');
    }

    return {
      mailboxId: mailbox.id,
      mailboxEmail: mailbox.email,
      department: mailbox.department,
      // App-only mode is "connected" by configuration (no per-mailbox token).
      connected: this.appOnlyEnabled || Boolean(mailbox.graphConnectedEmail),
      email: mailbox.graphConnectedEmail ?? null,
      displayName: mailbox.graphDisplayName ?? null,
      expiresAt: mailbox.graphTokenExpiresAt?.toISOString() ?? null,
      tenantId: mailbox.graphTenantId ?? null,
      hasRefreshToken: Boolean(mailbox.graphRefreshToken),
    };
  }

  async getAllMailboxConnectionStatuses() {
    const mailboxes = await this.prismaService.mailbox.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
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
      },
    });

    return mailboxes.map((mailbox) => ({
      id: mailbox.id,
      email: mailbox.email,
      department: mailbox.department,
      active: mailbox.active,
      lastSyncedAt: mailbox.lastSyncedAt?.toISOString() ?? null,
      graphConnected:
        this.appOnlyEnabled || Boolean(mailbox.graphConnectedEmail),
      graphConnectedEmail: mailbox.graphConnectedEmail ?? null,
      graphDisplayName: mailbox.graphDisplayName ?? null,
      graphTenantId: mailbox.graphTenantId ?? null,
      graphTokenExpiresAt: mailbox.graphTokenExpiresAt?.toISOString() ?? null,
      graphHasRefreshToken: Boolean(mailbox.graphRefreshToken),
    }));
  }

  buildFrontendSettingsRedirectUrl(params: {
    mailboxId?: string;
    status: 'connected' | 'error';
    reason?: string;
  }) {
    const url = new URL(this.frontendSettingsUrl);
    url.searchParams.set('microsoft', params.status);
    if (params.mailboxId) {
      url.searchParams.set('mailboxId', params.mailboxId);
    }
    if (params.reason) {
      url.searchParams.set('reason', params.reason);
    }
    return url.toString();
  }

  parseMailboxState(state: string | null | undefined): { mailboxId: string } {
    if (!state) {
      throw new Error('Microsoft OAuth state is missing.');
    }

    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { mailboxId?: string };
      if (!parsed.mailboxId) {
        throw new Error('Mailbox id missing in Microsoft OAuth state.');
      }
      return { mailboxId: parsed.mailboxId };
    } catch {
      throw new Error('Invalid Microsoft OAuth state.');
    }
  }

  createMailboxState(mailboxId: string) {
    return Buffer.from(JSON.stringify({ mailboxId }), 'utf8').toString(
      'base64url',
    );
  }

  async getInboxMessages(mailboxEmail: string) {
    const client = await this.getAuthenticatedClient(mailboxEmail);
    const response = (await client
      .api('/me/mailFolders/inbox/messages')
      .select('id,subject,from,receivedDateTime,bodyPreview,hasAttachments')
      .get()) as GraphInboxMessagesResponse;

    return response?.value ?? [];
  }
}
