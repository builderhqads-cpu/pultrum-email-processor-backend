import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sanitizeExtractedValue } from '../../utils/sanitize';

export type PdokGeocodingLookupInput = {
  address: string;
  city?: string | null;
  country: string;
};

// Mirrors GoogleGeocodingLookupResult so AddressEnrichmentService can treat both
// providers the same (incl. the `partialMatch` safety skip).
export type PdokGeocodingLookupResult = {
  zipcode: string | null;
  formattedAddress: string | null;
  partialMatch: boolean;
  raw: unknown;
};

type PdokDoc = {
  type?: string;
  postcode?: string;
  straatnaam?: string;
  woonplaatsnaam?: string;
  weergavenaam?: string;
  score?: number;
};

/**
 * Dutch postcode lookup via the PDOK Locatieserver (api.pdok.nl), which is built
 * on the authoritative BAG address registry — free, no API key, and far more
 * accurate for NL than Google (incl. for addresses without a house number).
 * NL-only; non-NL addresses stay on Google. We only return an EXACT address
 * match (type="adres" whose street matches and that carries a postcode); a
 * street-only / locality hit has no postcode, so — like Google's partial match —
 * we never guess a postcode (wrong delivery).
 */
@Injectable()
export class PdokGeocodingService {
  private readonly logger = new Logger(PdokGeocodingService.name);

  private readonly cache = new Map<
    string,
    { result: PdokGeocodingLookupResult; expiresAt: number }
  >();

  constructor(private readonly configService: ConfigService) {}

  private get enabled() {
    const raw = (this.configService.get<string>('PDOK_ENABLED') ?? 'true')
      .trim()
      .toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
  }

  private get baseUrl() {
    return (
      this.configService.get<string>('PDOK_BASE_URL') ??
      'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'
    )
      .trim()
      .replace(/\/+$/, '');
  }

  private get timeoutMs() {
    return Number(
      this.configService.get<string>('GEOCODING_TIMEOUT_MS') ?? '5000',
    );
  }

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

  private readFromCache(key: string): PdokGeocodingLookupResult | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.result;
  }

  private writeToCache(key: string, result: PdokGeocodingLookupResult) {
    const ttl = this.cacheTtlMs;
    if (ttl <= 0) return result;
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    return result;
  }

  private norm(s: string) {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** "7461JN" -> "7461 JN"; leaves anything non-PC6 untouched. */
  private formatDutchPostcode(raw: string) {
    const m = /^(\d{4})\s*([A-Za-z]{2})$/.exec(raw.trim());
    return m ? `${m[1]} ${m[2].toUpperCase()}` : raw.trim();
  }

  // A trailing house number, incl. ranges ("47-49") and letter suffixes
  // ("90B", "47 A"). Used both to strip the street and to require a number.
  private static readonly HOUSE_NUMBER_TAIL =
    /[\s,]+\d+\s*[a-z]?(\s*[-/]\s*\d+\s*[a-z]?)*\s*$/i;

  /** The street part of an address, dropping the trailing house number. */
  private streetOf(address: string) {
    return this.norm(
      address.replace(PdokGeocodingService.HOUSE_NUMBER_TAIL, ''),
    );
  }

  private houseNumberOf(address: string) {
    const m = PdokGeocodingService.HOUSE_NUMBER_TAIL.exec(address.trim());
    return m ? m[0].trim() : '';
  }

  private readonly MISS: PdokGeocodingLookupResult = {
    zipcode: null,
    formattedAddress: null,
    partialMatch: false,
    raw: null,
  };

  /** One PDOK free-text call restricted to addresses. Returns null on error. */
  private async fetchAddressDocs(
    q: string,
    rows: number,
  ): Promise<PdokDoc[] | null> {
    const params = new URLSearchParams({
      q,
      rows: String(rows),
      fq: 'type:adres',
      fl: 'type,weergavenaam,postcode,straatnaam,woonplaatsnaam,score',
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`PDOK lookup failed: status=${res.status} query=${q}`);
        return null;
      }
      const raw = await res.json().catch(() => null);
      return Array.isArray((raw as any)?.response?.docs)
        ? (raw as any).response.docs
        : [];
    } catch (err: any) {
      this.logger.warn(`PDOK request failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Exact address (has a house number) -> the PC6 of the matching address. */
  private async resolveExactAddress(
    address: string,
    city: string,
  ): Promise<PdokGeocodingLookupResult | null> {
    const docs = await this.fetchAddressDocs(
      [address, city].filter(Boolean).join(' '),
      5,
    );
    if (!docs) return null;
    const wantedStreet = this.streetOf(address);
    const match = docs.find(
      (d) =>
        d.type === 'adres' &&
        sanitizeExtractedValue(d.postcode ?? '') !== '' &&
        this.norm(d.straatnaam ?? '') === wantedStreet,
    );
    if (!match) return this.MISS;
    return {
      zipcode: this.formatDutchPostcode(
        sanitizeExtractedValue(match.postcode ?? ''),
      ),
      formattedAddress: sanitizeExtractedValue(match.weergavenaam ?? '') || null,
      partialMatch: false,
      raw: null,
    };
  }

  /**
   * Street with NO house number -> the PC6 only when the WHOLE street shares a
   * single one (common for short/new streets, e.g. construction sites). A street
   * that spans several PC6 can't be pinned without the number, so we leave it
   * missing (never guess the wrong segment). PC4-only ("approximate") is a
   * separate policy decision and not done here.
   */
  private async resolveStreet(
    address: string,
    city: string,
  ): Promise<PdokGeocodingLookupResult | null> {
    const wantedStreet = this.streetOf(address);
    if (!wantedStreet) return this.MISS;

    const docs = await this.fetchAddressDocs(
      [wantedStreet, city].filter(Boolean).join(' '),
      100,
    );
    if (!docs) return null;

    let streetDocs = docs.filter(
      (d) =>
        d.type === 'adres' &&
        sanitizeExtractedValue(d.postcode ?? '') !== '' &&
        this.norm(d.straatnaam ?? '') === wantedStreet,
    );

    const cities = new Set(
      streetDocs.map((d) => this.norm(d.woonplaatsnaam ?? '')).filter(Boolean),
    );
    if (city) {
      const nc = this.norm(city);
      streetDocs = streetDocs.filter(
        (d) => this.norm(d.woonplaatsnaam ?? '') === nc,
      );
    } else if (cities.size !== 1) {
      // Same street name in several towns and no city given -> ambiguous.
      return this.MISS;
    }

    // 100 = the row cap: if we hit it, the street may be longer than we saw, so
    // we can't be sure the rest share the postcode.
    if (!streetDocs.length || streetDocs.length >= 100) return this.MISS;

    const postcodes = new Set(
      streetDocs.map((d) =>
        sanitizeExtractedValue(d.postcode ?? '').toUpperCase(),
      ),
    );
    if (postcodes.size !== 1) return this.MISS;

    return {
      zipcode: this.formatDutchPostcode([...postcodes][0]),
      formattedAddress:
        `${wantedStreet}${city ? `, ${city}` : [...cities][0] ? `, ${[...cities][0]}` : ''}` ||
        null,
      partialMatch: false,
      raw: null,
    };
  }

  async lookupZipcode(
    input: PdokGeocodingLookupInput,
  ): Promise<PdokGeocodingLookupResult | null> {
    if (!this.enabled) return null;

    // PDOK is the Dutch national registry — NL only.
    const country = sanitizeExtractedValue(input.country).toUpperCase();
    if (country !== 'NL') return null;

    const address = sanitizeExtractedValue(input.address);
    const city = sanitizeExtractedValue(input.city ?? '');
    if (!address) return null;

    const key = this.cacheKey(country, address, city);
    const cached = this.readFromCache(key);
    if (cached) return cached;

    // With a house number -> exact address; without one -> single-PC6 street.
    const result = this.houseNumberOf(address)
      ? await this.resolveExactAddress(address, city)
      : await this.resolveStreet(address, city);

    // null = transient error (don't cache); a definitive miss (zipcode null) is
    // cached so we don't re-hit PDOK for the same address.
    return result === null ? null : this.writeToCache(key, result);
  }
}
