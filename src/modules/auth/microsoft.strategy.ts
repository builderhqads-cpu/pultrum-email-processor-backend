import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';

type TokenParams = {
  expires_in?: string | number;
};

type MicrosoftAuthResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  expiresInSeconds?: number;
};

@Injectable()
export class MicrosoftStrategy extends PassportStrategy(
  OAuth2Strategy,
  'microsoft',
) {
  constructor(configService: ConfigService) {
    const tenantId = configService.get<string>('MS_TENANT_ID') || 'common';
    const configuredClientId = (
      configService.get<string>('MS_CLIENT_ID') || ''
    ).trim();
    const configuredClientSecret = (
      configService.get<string>('MS_CLIENT_SECRET') || ''
    ).trim();
    const clientID = configuredClientId || 'disabled';
    const clientSecret = configuredClientSecret || 'disabled';
    const port = configService.get<string>('PORT', '3000');
    const callbackURL =
      configService.get<string>('MS_REDIRECT_URI') ||
      `http://localhost:${port}/auth/callback`;

    // Passport's OAuth2Strategy constructor typing is too loose for eslint here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    super({
      authorizationURL: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
      tokenURL: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      clientID,
      clientSecret,
      callbackURL,
      scope: [
        'openid',
        'profile',
        'offline_access',
        'User.Read',
        // Mail.ReadWrite (superset of Mail.Read) is required to thread replies
        // via Graph's native createReply (it creates a draft).
        'Mail.ReadWrite',
        'Mail.Send',
      ],
      scopeSeparator: ' ',
      skipUserProfile: true,
    });

    if (!configuredClientId || !configuredClientSecret) {
      // Avoid crashing the app on startup; the guard will block the endpoints.
      // This still registers the strategy but with dummy credentials.
      new Logger(MicrosoftStrategy.name).warn(
        'Microsoft OAuth is not configured (MS_CLIENT_ID/MS_CLIENT_SECRET). Auth endpoints will return 503.',
      );
    }
  }

  validate(
    accessToken: string,
    refreshToken: string | undefined,
    paramsOrProfile: TokenParams | Record<string, unknown>,
  ) {
    const params: TokenParams =
      paramsOrProfile &&
      typeof paramsOrProfile === 'object' &&
      'expires_in' in (paramsOrProfile as Record<string, unknown>)
        ? paramsOrProfile
        : {};

    const expiresInSeconds =
      typeof params?.expires_in === 'string'
        ? Number(params.expires_in)
        : params?.expires_in;

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (Number(expiresInSeconds ?? 3600) - 30) * 1000,
      expiresInSeconds,
    } satisfies MicrosoftAuthResult;
  }
}
