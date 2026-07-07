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

  constructor(private readonly configService: ConfigService) {}

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
        return {
          zipcode: null,
          formattedAddress: null,
          partialMatch: false,
          raw,
        };
      }

      const results = Array.isArray((raw as any)?.results)
        ? (raw as any).results
        : [];
      const first = results.find(
        (result: any) => this.extractPostalCode(result).length > 0,
      );

      if (!first) {
        return {
          zipcode: null,
          formattedAddress: null,
          partialMatch: false,
          raw,
        };
      }

      return {
        zipcode: this.extractPostalCode(first) || null,
        formattedAddress:
          sanitizeExtractedValue(first?.formatted_address ?? '') || null,
        partialMatch: Boolean(first?.partial_match),
        raw,
      };
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
