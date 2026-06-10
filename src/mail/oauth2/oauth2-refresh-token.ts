import 'isomorphic-fetch';

export type OAuth2RefreshTokenRequest = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
  redirectUri?: string;
};

export type OAuth2TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  tokenType?: string;
};

export async function fetchAccessTokenFromRefreshToken(
  input: OAuth2RefreshTokenRequest,
): Promise<OAuth2TokenResponse> {
  const tokenEndpoint = input.tokenEndpoint.trim();
  const clientId = input.clientId.trim();
  const refreshToken = input.refreshToken.trim();

  if (!tokenEndpoint) throw new Error('OAuth2 tokenEndpoint is required');
  if (!clientId) throw new Error('OAuth2 clientId is required');
  if (!refreshToken) throw new Error('OAuth2 refreshToken is required');

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', clientId);
  body.set('refresh_token', refreshToken);

  const clientSecret = (input.clientSecret || '').trim();
  if (clientSecret) body.set('client_secret', clientSecret);

  const redirectUri = (input.redirectUri || '').trim();
  if (redirectUri) body.set('redirect_uri', redirectUri);

  const scope = (input.scope || '').trim();
  if (scope) body.set('scope', scope);

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth2 token request failed: ${res.status} ${text}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('OAuth2 token response was not valid JSON');
  }

  if (!json?.access_token) {
    throw new Error('OAuth2 token response missing access_token');
  }

  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresInSeconds: json.expires_in ? Number(json.expires_in) : undefined,
    tokenType: json.token_type ? String(json.token_type) : undefined,
  };
}
