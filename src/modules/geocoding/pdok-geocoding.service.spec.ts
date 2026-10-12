import { ConfigService } from '@nestjs/config';
import { PdokGeocodingService } from './pdok-geocoding.service';

function makeConfig(overrides: Record<string, string> = {}) {
  return {
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
}

function mockFetchOnce(docs: unknown[], ok = true, status = 200) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ response: { docs } }),
  });
}

describe('PdokGeocodingService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it('returns the exact postcode for an address-level match (formatted with a space)', async () => {
    mockFetchOnce([
      {
        type: 'adres',
        straatnaam: 'Noordermorssingel',
        postcode: '7461JN',
        weergavenaam: 'Noordermorssingel 22, 7461JN Rijssen',
        score: 18.2,
      },
    ]);
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Noordermorssingel 22',
      city: 'Rijssen',
      country: 'NL',
    });
    expect(res?.zipcode).toBe('7461 JN');
    expect(res?.partialMatch).toBe(false);
  });

  it('handles a house-number RANGE ("47-49") and still matches the street', async () => {
    mockFetchOnce([
      {
        type: 'adres',
        straatnaam: 'Zeeburgerpad',
        postcode: '1019AB',
        weergavenaam: 'Zeeburgerpad 49A, 1019AB Amsterdam',
        score: 13.9,
      },
    ]);
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Zeeburgerpad 47-49',
      city: 'Amsterdam',
      country: 'NL',
    });
    expect(res?.zipcode).toBe('1019 AB');
  });

  it('no house number: resolves exactly when the WHOLE street is one PC6', async () => {
    mockFetchOnce([
      { type: 'adres', straatnaam: 'Hooischudderdreef', woonplaatsnaam: 'Harderwijk', postcode: '3845NB' },
      { type: 'adres', straatnaam: 'Hooischudderdreef', woonplaatsnaam: 'Harderwijk', postcode: '3845NB' },
      { type: 'adres', straatnaam: 'Hooischudderdreef', woonplaatsnaam: 'Harderwijk', postcode: '3845NB' },
    ]);
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Hooischudderdreef',
      city: 'Harderwijk',
      country: 'NL',
    });
    expect(res?.zipcode).toBe('3845 NB');
  });

  it('no house number: returns null when the street spans multiple PC6', async () => {
    mockFetchOnce([
      { type: 'adres', straatnaam: 'Molendijk Noord', woonplaatsnaam: 'Rijssen', postcode: '7461JB' },
      { type: 'adres', straatnaam: 'Molendijk Noord', woonplaatsnaam: 'Rijssen', postcode: '7461JD' },
    ]);
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Molendijk Noord',
      city: 'Rijssen',
      country: 'NL',
    });
    expect(res?.zipcode).toBeNull();
  });

  it('returns a null zipcode when the street does not match (never guesses)', async () => {
    mockFetchOnce([
      {
        type: 'adres',
        straatnaam: 'Andere Straat',
        postcode: '1234AB',
        weergavenaam: 'Andere Straat 1, 1234AB Plaats',
        score: 9,
      },
    ]);
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Molendijk Noord 90',
      city: 'Rijssen',
      country: 'NL',
    });
    expect(res?.zipcode).toBeNull();
  });

  it('returns null for non-NL countries (Google handles those)', async () => {
    (global as any).fetch = jest.fn();
    const svc = new PdokGeocodingService(makeConfig());
    const res = await svc.lookupZipcode({
      address: 'Hafenstrasse 5',
      city: 'Münster',
      country: 'DE',
    });
    expect(res).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('returns null when disabled', async () => {
    (global as any).fetch = jest.fn();
    const svc = new PdokGeocodingService(makeConfig({ PDOK_ENABLED: 'false' }));
    const res = await svc.lookupZipcode({
      address: 'Noordermorssingel 22',
      city: 'Rijssen',
      country: 'NL',
    });
    expect(res).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});
