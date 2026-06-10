import { fetchAccessTokenFromRefreshToken } from './oauth2-refresh-token';

describe('fetchAccessTokenFromRefreshToken', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('throws when tokenEndpoint is missing', async () => {
    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: '',
        clientId: 'x',
        refreshToken: 'y',
      }),
    ).rejects.toThrow('tokenEndpoint');
  });

  it('throws when clientId is missing', async () => {
    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: 'https://example.com/token',
        clientId: '',
        refreshToken: 'y',
      }),
    ).rejects.toThrow('clientId');
  });

  it('throws when refreshToken is missing', async () => {
    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: 'https://example.com/token',
        clientId: 'x',
        refreshToken: '',
      }),
    ).rejects.toThrow('refreshToken');
  });

  it('returns access token from JSON response', async () => {
    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'access123',
            refresh_token: 'refresh456',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      } as any;
    }) as any;

    const res = await fetchAccessTokenFromRefreshToken({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      scope: 'scope1 scope2',
      redirectUri: 'http://localhost/callback',
    });

    expect(res).toEqual({
      accessToken: 'access123',
      refreshToken: 'refresh456',
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    });
  });

  it('throws on non-2xx responses', async () => {
    global.fetch = jest.fn(async () => {
      return {
        ok: false,
        status: 400,
        text: async () => 'bad request',
      } as any;
    }) as any;

    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: 'https://example.com/token',
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    ).rejects.toThrow('400');
  });

  it('throws when response is not JSON', async () => {
    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => 'not json',
      } as any;
    }) as any;

    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: 'https://example.com/token',
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    ).rejects.toThrow('valid JSON');
  });

  it('throws when access_token is missing', async () => {
    global.fetch = jest.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token_type: 'Bearer' }),
      } as any;
    }) as any;

    await expect(
      fetchAccessTokenFromRefreshToken({
        tokenEndpoint: 'https://example.com/token',
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    ).rejects.toThrow('access_token');
  });
});
