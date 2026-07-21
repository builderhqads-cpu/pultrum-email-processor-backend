import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sanitizeExtractedValue } from '../../utils/sanitize';

export type GoogleGeocodingLookupInput = {
  address: string;
  city?: string | null;
  country: string;
};

export type GoogleGeocodingLookupResult = {
  zipcode: string | null;
  formattedAddress: string | null;
  partialMatch: boolean;
  raw: unknown;
};

const SUPPORTED_COUNTRY_CODES = new Set([
  'AD',
  'AL',
  'AT',
  'BA',
  'BE',
  'BG',
  'BY',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MC',
  'MD',
  'ME',
  'MK',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'RS',
  'SE',
  'SI',
  'SK',
  'SM',
  'TR',
  'UA',
  'VA',
]);

@Injectable()
export class GoogleGeocodingService {
  private readonly logger = new Logger(GoogleGeocodingService.name);

  /**
   * In-memory lookup cache. The same address is geocoded over and over
   * otherwise: every order of a batch (a Dispoliste has ~25 orders that all
   * load at the SAME pickup address) and every reprocess would be a new paid
   * Google call. Only definitive answers are cached — never transient failures.
   */
  private readonly cache = new Map<
    string,
    { result: GoogleGeocodingLookupResult; expiresAt: number }
  >();

  constructor(private readonly configService: ConfigService) {}

  private get cacheTtlMs() {
    const raw = Number(
      this.configService.get<string>('GEOCODING_CACHE_TTL_MS') ?? '86400000',
    );
    return Number.isFinite(raw) ? raw : 86_400_000;
  }

  private get cacheMaxEntries() {
    const raw = Number(
      this.configService.get<string>('GEOCODING_CACHE_MAX_ENTRIES') ?? '5000',
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 5000;
  }

  private cacheKey(country: string, address: string, city: string) {
    return [country, address, city]
      .map((part) => (part ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
      .join('|');
  }

  private readFromCache(key: string): GoogleGeocodingLookupResult | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.result;
  }

  /** Store a DEFINITIVE answer only (callers must not pass transient errors). */
  private writeToCache(key: string, result: GoogleGeocodingLookupResult) {
    const ttl = this.cacheTtlMs;
    if (ttl <= 0) return result;

    // Bounded: drop the oldest entry (Map keeps insertion order).
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }

    this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    return result;
  }

  private get enabled() {
    const raw = (
      this.configService.get<string>('GEOCODING_ENABLED') ?? 'true'
    )
      .trim()
      .toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
  }

  private get apiKey() {
    return (
      this.configService.get<string>('GOOGLE_GEOCODING_API_KEY') ?? ''
    ).trim();
  }

  private get baseUrl() {
    return (
      this.configService.get<string>('GOOGLE_GEOCODING_BASE_URL') ??
      'https://maps.googleapis.com/maps/api/geocode/json'
    )
      .trim()
      .replace(/\/+$/, '');
  }

  private get timeoutMs() {
    return Number(
      this.configService.get<string>('GEOCODING_TIMEOUT_MS') ?? '5000',
    );
  }

  private extractPostalCode(raw: any) {
    const components = Array.isArray(raw?.address_components)
      ? raw.address_components
      : [];

    for (const component of components) {
      const types = Array.isArray(component?.types) ? component.types : [];
      if (!types.includes('postal_code')) continue;

      const zipcode = sanitizeExtractedValue(component?.long_name ?? '');
      if (zipcode) return zipcode;
    }

    return '';
  }

  async lookupZipcode(
    input: GoogleGeocodingLookupInput,
  ): Promise<GoogleGeocodingLookupResult | null> {
    if (!this.enabled || !this.apiKey) return null;

    const country = sanitizeExtractedValue(input.country).toUpperCase();
    if (!SUPPORTED_COUNTRY_CODES.has(country)) return null;

    const address = sanitizeExtractedValue(input.address);
    const city = sanitizeExtractedValue(input.city ?? '');
    if (!address) return null;

    const key = this.cacheKey(country, address, city);
    const cached = this.readFromCache(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      address: [address, city].filter(Boolean).join(', '),
      components: `country:${country}`,
      key: this.apiKey,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      });
      const raw = await res.json().catch(() => null);
      if (!res.ok) {
        this.logger.warn(
          `Google geocoding failed: status=${res.status} query=${params.get('address') ?? ''}`,
        );
        return null;
      }

      const status = sanitizeExtractedValue((raw as any)?.status ?? '');
      if (status !== 'OK') {
        this.logger.warn(
          `Google geocoding returned status=${status || 'UNKNOWN'} query=${params.get('address') ?? ''}`,
        );
        const empty: GoogleGeocodingLookupResult = {
          zipcode: null,
          formattedAddress: null,
          partialMatch: false,
          raw,
        };
        // ZERO_RESULTS is a definitive "this address does not exist" -> cache it.
        // Everything else (OVER_QUERY_LIMIT, REQUEST_DENIED, UNKNOWN_ERROR) is
        // transient or a config problem: caching it would keep failing for the
        // whole TTL even after the cause is fixed.
        return status === 'ZERO_RESULTS'
          ? this.writeToCache(key, empty)
          : empty;
      }

      const results = Array.isArray((raw as any)?.results)
        ? (raw as any).results
        : [];
      const first = results.find(
        (result: any) => this.extractPostalCode(result).length > 0,
      );

      if (!first) {
        // Status was OK but no result carries a postal code -> definitive.
        return this.writeToCache(key, {
          zipcode: null,
          formattedAddress: null,
          partialMatch: false,
          raw,
        });
      }

      return this.writeToCache(key, {
        zipcode: this.extractPostalCode(first) || null,
        formattedAddress:
          sanitizeExtractedValue(first?.formatted_address ?? '') || null,
        partialMatch: Boolean(first?.partial_match),
        raw,
      });
    } catch (err: any) {
      this.logger.warn(
        `Google geocoding request failed: ${err?.message ?? err}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
