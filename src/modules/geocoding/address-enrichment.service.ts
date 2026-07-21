import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegexExtractionService } from '../regex-extraction/regex-extraction.service';
import { TransportBookingValidationService } from '../transport-booking-validation/transport-booking-validation.service';
import { splitStreetAddress } from '../../utils/field-normalize';
import { sanitizeExtractedValue } from '../../utils/sanitize';
import { GoogleGeocodingService } from './google-geocoding.service';

type DetectedFieldLike = {
  key: string;
  label?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
};

export type ZipcodeEnrichmentHint = {
  key: 'pickup_zipcode' | 'delivery_zipcode';
  label: string;
  value: string;
  confidence: number;
  /** Looked up in an official address database — strong, but an inference. */
  source: 'geocoding';
};

const RELEVANT_KEYS = new Set([
  'pickup_address',
  'pickup_city',
  'pickup_country',
  'pickup_zipcode',
  'delivery_address',
  'delivery_city',
  'delivery_country',
  'delivery_zipcode',
]);

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  albania: 'AL',
  alemanha: 'DE',
  andorra: 'AD',
  austria: 'AT',
  belarus: 'BY',
  belgica: 'BE',
  belgie: 'BE',
  belgium: 'BE',
  bosnia: 'BA',
  'bosnia and herzegovina': 'BA',
  bulgaria: 'BG',
  croacia: 'HR',
  croatia: 'HR',
  cyprus: 'CY',
  czechia: 'CZ',
  'czech republic': 'CZ',
  denemarken: 'DK',
  denmark: 'DK',
  dinamarca: 'DK',
  duitsland: 'DE',
  deutschland: 'DE',
  england: 'GB',
  espana: 'ES',
  espanha: 'ES',
  estonia: 'EE',
  finland: 'FI',
  finlandia: 'FI',
  france: 'FR',
  francia: 'FR',
  germany: 'DE',
  greece: 'GR',
  grecia: 'GR',
  griekenland: 'GR',
  holland: 'NL',
  hungary: 'HU',
  hungria: 'HU',
  iceland: 'IS',
  ireland: 'IE',
  irlanda: 'IE',
  italia: 'IT',
  italy: 'IT',
  latvia: 'LV',
  liechtenstein: 'LI',
  lithuania: 'LT',
  lituania: 'LT',
  luxembourg: 'LU',
  luxemburgo: 'LU',
  macedonia: 'MK',
  malta: 'MT',
  moldova: 'MD',
  montenegro: 'ME',
  nederland: 'NL',
  netherlands: 'NL',
  noruega: 'NO',
  norway: 'NO',
  oostenrijk: 'AT',
  poland: 'PL',
  polen: 'PL',
  polonia: 'PL',
  polska: 'PL',
  portugal: 'PT',
  romania: 'RO',
  roemenie: 'RO',
  sanmarino: 'SM',
  scotland: 'GB',
  serbia: 'RS',
  slowakije: 'SK',
  slovakia: 'SK',
  slovenia: 'SI',
  slovenie: 'SI',
  spain: 'ES',
  suisse: 'CH',
  suica: 'CH',
  sweden: 'SE',
  schweiz: 'CH',
  switzerland: 'CH',
  turkiye: 'TR',
  turkey: 'TR',
  ucrania: 'UA',
  uk: 'GB',
  ukraine: 'UA',
  'united kingdom': 'GB',
  unitedkingdom: 'GB',
  vatican: 'VA',
  wales: 'GB',
  witrusland: 'BY',
};

const THREE_LETTER_COUNTRY_TO_CODE: Record<string, string> = {
  AUT: 'AT',
  BEL: 'BE',
  BGR: 'BG',
  BIH: 'BA',
  BLR: 'BY',
  CHE: 'CH',
  CYP: 'CY',
  CZE: 'CZ',
  DEU: 'DE',
  DNK: 'DK',
  ESP: 'ES',
  EST: 'EE',
  FIN: 'FI',
  FRA: 'FR',
  GBR: 'GB',
  GRC: 'GR',
  HRV: 'HR',
  HUN: 'HU',
  IRL: 'IE',
  ISL: 'IS',
  ITA: 'IT',
  LTU: 'LT',
  LUX: 'LU',
  LVA: 'LV',
  MDA: 'MD',
  MKD: 'MK',
  MLT: 'MT',
  MNE: 'ME',
  NLD: 'NL',
  NOR: 'NO',
  POL: 'PL',
  PRT: 'PT',
  ROU: 'RO',
  SRB: 'RS',
  SVK: 'SK',
  SVN: 'SI',
  SWE: 'SE',
  TUR: 'TR',
  UKR: 'UA',
};

@Injectable()
export class AddressEnrichmentService {
  private readonly logger = new Logger(AddressEnrichmentService.name);

  constructor(
    private readonly googleGeocodingService: GoogleGeocodingService,
    private readonly regexExtractionService: RegexExtractionService,
    private readonly transportBookingValidationService: TransportBookingValidationService,
    // Last on purpose: any positional construction keeps working, and the
    // optional read below falls back to the SAFE default (reject partials).
    private readonly configService?: ConfigService,
  ) {}

  /**
   * Google sets `partial_match` when it could NOT match the address exactly —
   * typically the house number/street wasn't found and it fell back to the
   * locality, returning the postal code of the city centre. Accepting that
   * would put a plausible-but-wrong zipcode on the order (wrong delivery).
   * Default: reject. Set GEOCODING_ALLOW_PARTIAL_MATCH=true to opt back in.
   */
  private get allowPartialMatch(): boolean {
    const raw = (
      this.configService?.get<string>('GEOCODING_ALLOW_PARTIAL_MATCH') ?? ''
    )
      .trim()
      .toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
  }

  private countryKey(raw: string) {
    return raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private normalizeCountry(raw: string | null | undefined) {
    const value = sanitizeExtractedValue(raw ?? '');
    if (!value) return '';

    const paren = value.match(/\(([A-Za-z]{2})\)/);
    if (paren?.[1]) return paren[1].toUpperCase();

    const two = value.match(/^[A-Za-z]{2}$/);
    if (two) return value.toUpperCase();

    const three = value.match(/^[A-Za-z]{3}$/);
    if (three) {
      const code = THREE_LETTER_COUNTRY_TO_CODE[value.toUpperCase()];
      if (code) return code;
    }

    const normalized = this.countryKey(value);
    const direct = COUNTRY_NAME_TO_CODE[normalized];
    if (direct) return direct;

    for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
      if (normalized.includes(name)) return code;
    }

    return value.toUpperCase();
  }

  private labelFor(key: ZipcodeEnrichmentHint['key']) {
    return key === 'pickup_zipcode' ? 'Pickup zipcode' : 'Delivery zipcode';
  }

  private setIfMissing(
    map: Map<string, string>,
    key: string,
    value: string | null | undefined,
  ) {
    if (!RELEVANT_KEYS.has(key)) return;
    if (map.get(key)) return;
    const cleaned = sanitizeExtractedValue(value ?? '');
    if (!cleaned) return;
    map.set(key, cleaned);
  }

  private collectSeedMap(params: {
    combinedText?: string | null;
    emailSubject?: string | null;
    fieldValues?: Record<string, unknown>;
    detectedFields?: DetectedFieldLike[];
  }) {
    const map = new Map<string, string>();

    for (const [key, value] of Object.entries(params.fieldValues ?? {})) {
      if (!RELEVANT_KEYS.has(key)) continue;
      this.setIfMissing(map, key, value == null ? '' : String(value));
    }

    for (const field of params.detectedFields ?? []) {
      if (!field?.key || !RELEVANT_KEYS.has(field.key)) continue;
      this.setIfMissing(map, field.key, field.value ?? '');
    }

    const haystack = (params.combinedText ?? '').toString().trim();
    if (!haystack) return map;

    const labelPreview =
      this.transportBookingValidationService.previewDetectedFieldsFromText({
        haystack,
        emailSubject: params.emailSubject ?? '',
      });
    for (const field of labelPreview) {
      if (!field?.key || !RELEVANT_KEYS.has(field.key)) continue;
      this.setIfMissing(map, field.key, field.value);
    }

    const regexFields = this.regexExtractionService.extract(
      haystack,
      [
        ...(params.detectedFields ?? []).map((field) => ({
          key: field.key,
          value: field.value ?? undefined,
          confidence: field.confidence ?? undefined,
          source: field.source ?? undefined,
        })),
        ...labelPreview.map((field) => ({
          key: field.key,
          value: field.value,
          confidence: field.confidence,
          source: field.source,
        })),
      ],
    );
    for (const field of regexFields) {
      if (!field?.key || !RELEVANT_KEYS.has(field.key)) continue;
      this.setIfMissing(map, field.key, field.value);
    }

    return map;
  }

  async resolveZipcodeHints(params: {
    combinedText?: string | null;
    emailSubject?: string | null;
    fieldValues?: Record<string, unknown>;
    detectedFields?: DetectedFieldLike[];
  }): Promise<ZipcodeEnrichmentHint[]> {
    const map = this.collectSeedMap(params);
    const hints: ZipcodeEnrichmentHint[] = [];

    for (const side of ['pickup', 'delivery'] as const) {
      const zipcodeKey = `${side}_zipcode` as ZipcodeEnrichmentHint['key'];
      const addressKey = `${side}_address`;
      const cityKey = `${side}_city`;
      const countryKey = `${side}_country`;

      const split = splitStreetAddress({
        address: map.get(addressKey) ?? '',
        zipcode: map.get(zipcodeKey) ?? '',
        city: map.get(cityKey) ?? '',
      });
      if (split.address) map.set(addressKey, split.address);
      if (split.city && !map.get(cityKey)) map.set(cityKey, split.city);
      if (split.zipcode) {
        map.set(zipcodeKey, split.zipcode);
      }

      if (sanitizeExtractedValue(map.get(zipcodeKey) ?? '')) continue;

      const address = sanitizeExtractedValue(map.get(addressKey) ?? '');
      const city = sanitizeExtractedValue(map.get(cityKey) ?? '');
      const country = this.normalizeCountry(map.get(countryKey) ?? '');

      if (!address || !country) continue;

      const geocoded = await this.googleGeocodingService.lookupZipcode({
        address,
        city,
        country,
      });

      // Never take a zipcode from an inexact match — better to leave it missing
      // and ask the customer than to ship to the wrong postal code.
      if (geocoded?.partialMatch && !this.allowPartialMatch) {
        this.logger.warn(
          `Skipping ${side} zipcode (Google PARTIAL match) for ${[address, city, country].filter(Boolean).join(', ')}` +
            (geocoded.formattedAddress
              ? ` -> matched '${geocoded.formattedAddress}'`
              : ''),
        );
        continue;
      }

      const zipcode = sanitizeExtractedValue(geocoded?.zipcode ?? '');
      if (!zipcode) {
        this.logger.log(
          `Google zipcode not found for ${side}: ${[address, city, country].filter(Boolean).join(', ')}`,
        );
        continue;
      }

      hints.push({
        key: zipcodeKey,
        label: this.labelFor(zipcodeKey),
        value: zipcode,
        confidence: 0.92,
        source: 'geocoding',
      });
    }

    return hints;
  }
}
