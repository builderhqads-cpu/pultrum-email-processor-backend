import { GoogleGeocodingService } from './google-geocoding.service';

function makeService(overrides: Record<string, string> = {}) {
  const config = {
    get: (key: string) =>
      ({
        GEOCODING_ENABLED: 'true',
        GOOGLE_GEOCODING_API_KEY: 'test-key',
        ...overrides,
      })[key],
  } as any;
  return new GoogleGeocodingService(config);
}

function mockFetchOnce(payload: unknown, ok = true) {
  return jest.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  })) as any;
}

const OK_RESPONSE = {
  status: 'OK',
  results: [
    {
      formatted_address: 'Maansteen 31, 1703 TX Heerhugowaard, Netherlands',
      partial_match: false,
      address_components: [
        { types: ['postal_code'], long_name: '1703 TX' },
      ],
    },
  ],
};

describe('GoogleGeocodingService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns the postal code and reports an exact match', async () => {
    global.fetch = mockFetchOnce(OK_RESPONSE);
    const service = makeService();

    const result = await service.lookupZipcode({
      address: 'Maansteen 31',
      city: 'Heerhugowaard',
      country: 'NL',
    });

    expect(result?.zipcode).toBe('1703 TX');
    expect(result?.partialMatch).toBe(false);
  });

  it('surfaces partial_match so the caller can reject an inexact match', async () => {
    global.fetch = mockFetchOnce({
      status: 'OK',
      results: [
        {
          formatted_address: 'Heerhugowaard, Netherlands',
          partial_match: true,
          address_components: [{ types: ['postal_code'], long_name: '1701' }],
        },
      ],
    });
    const service = makeService();

    const result = await service.lookupZipcode({
      address: 'Rua Inexistente 999',
      city: 'Heerhugowaard',
      country: 'NL',
    });

    expect(result?.partialMatch).toBe(true);
  });

  it('caches a successful lookup (same address is not billed twice)', async () => {
    const fetchMock = mockFetchOnce(OK_RESPONSE);
    global.fetch = fetchMock;
    const service = makeService();

    const query = {
      address: 'Maansteen 31',
      city: 'Heerhugowaard',
      country: 'NL',
    };
    const first = await service.lookupZipcode(query);
    const second = await service.lookupZipcode(query);

    expect(first?.zipcode).toBe('1703 TX');
    expect(second?.zipcode).toBe('1703 TX');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes the cache key (spacing/casing do not cause a second call)', async () => {
    const fetchMock = mockFetchOnce(OK_RESPONSE);
    global.fetch = fetchMock;
    const service = makeService();

    await service.lookupZipcode({
      address: 'Maansteen 31',
      city: 'Heerhugowaard',
      country: 'NL',
    });
    await service.lookupZipcode({
      address: '  maansteen   31 ',
      city: 'HEERHUGOWAARD',
      country: 'nl',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches ZERO_RESULTS but NOT a transient error status', async () => {
    const zeroFetch = mockFetchOnce({ status: 'ZERO_RESULTS', results: [] });
    global.fetch = zeroFetch;
    const zeroService = makeService();
    const zeroQuery = { address: 'Nowhere 1', city: 'X', country: 'NL' };
    await zeroService.lookupZipcode(zeroQuery);
    await zeroService.lookupZipcode(zeroQuery);
    expect(zeroFetch).toHaveBeenCalledTimes(1);

    const deniedFetch = mockFetchOnce({ status: 'REQUEST_DENIED' });
    global.fetch = deniedFetch;
    const deniedService = makeService();
    const deniedQuery = { address: 'Dam 63', city: 'Niederkruchten', country: 'DE' };
    await deniedService.lookupZipcode(deniedQuery);
    await deniedService.lookupZipcode(deniedQuery);
    // Must retry: a denied key would otherwise stay broken for the whole TTL.
    expect(deniedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network failure', async () => {
    const failingFetch = jest.fn(async () => {
      throw new Error('network down');
    }) as any;
    global.fetch = failingFetch;
    const service = makeService();
    const query = { address: 'Dam 63', city: 'Niederkruchten', country: 'DE' };

    expect(await service.lookupZipcode(query)).toBeNull();
    expect(await service.lookupZipcode(query)).toBeNull();
    expect(failingFetch).toHaveBeenCalledTimes(2);
  });

  it('skips unsupported countries and missing api key without calling Google', async () => {
    const fetchMock = mockFetchOnce(OK_RESPONSE);
    global.fetch = fetchMock;

    const service = makeService();
    expect(
      await service.lookupZipcode({ address: 'X 1', city: 'Y', country: 'BR' }),
    ).toBeNull();

    const noKey = makeService({ GOOGLE_GEOCODING_API_KEY: '' });
    expect(
      await noKey.lookupZipcode({ address: 'X 1', city: 'Y', country: 'NL' }),
    ).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
