import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const SETTINGS_ID = 'default';

const SYNC_MODES = ['MANUAL', 'AUTOMATIC'] as const;
const DELIVERY_MODES = ['MANUAL', 'SELECTIVE', 'AUTONOMOUS'] as const;

export type UpdateAutomationDto = {
  syncMode?: string;
  deliveryMode?: string;
  autoXmlConfidenceThreshold?: number;
  xmlConfirmationEnabled?: boolean;
  // Base Subject/Body = the Dutch (default) template.
  xmlConfirmationSubject?: string | null;
  xmlConfirmationBody?: string | null;
  // Optional per-language overrides (fall back to Dutch when empty).
  xmlConfirmationSubjectEn?: string | null;
  xmlConfirmationBodyEn?: string | null;
  xmlConfirmationSubjectDe?: string | null;
  xmlConfirmationBodyDe?: string | null;
};

export type ConfirmationLang = 'nl' | 'en' | 'de';

// Default template Niek can edit. {greeting} = time-based greeting (localized).
export const DEFAULT_XML_CONFIRMATION_BODY =
  '{greeting},\n\nBedankt, we hebben de order(s) verwerkt.';

// Normalize whatever the classifier stored (a code like "de" or a name like
// "German"/"Duits"/"Deutsch") into one of our 3 template languages. Anything
// unrecognized (incl. "unknown"/empty/pt/...) falls back to Dutch, matching the
// per-language fallback of the template itself (Renato 2026-10-08).
export function normalizeConfirmationLang(
  raw: string | null | undefined,
): ConfirmationLang {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'nl';
  // Check German/English by exact code or full word; avoid substring traps
  // (e.g. "nederlands" contains "de", so we never bare-match "de").
  if (s === 'de' || s.includes('duits') || s.includes('deutsch') || s.includes('german'))
    return 'de';
  if (s === 'en' || s.includes('engels') || s.includes('english')) return 'en';
  return 'nl';
}

@Injectable()
export class SystemSettingsService {
  constructor(private readonly prismaService: PrismaService) {}

  /** Reads the singleton settings row, creating it with defaults if missing. */
  async get() {
    return this.prismaService.systemSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async update(dto: UpdateAutomationDto) {
    const data: UpdateAutomationDto = {};

    if (dto.syncMode !== undefined) {
      if (!(SYNC_MODES as readonly string[]).includes(dto.syncMode)) {
        throw new BadRequestException(
          `Invalid syncMode. Allowed: ${SYNC_MODES.join(', ')}`,
        );
      }
      data.syncMode = dto.syncMode;
    }

    if (dto.deliveryMode !== undefined) {
      if (!(DELIVERY_MODES as readonly string[]).includes(dto.deliveryMode)) {
        throw new BadRequestException(
          `Invalid deliveryMode. Allowed: ${DELIVERY_MODES.join(', ')}`,
        );
      }
      data.deliveryMode = dto.deliveryMode;
    }

    if (dto.autoXmlConfidenceThreshold !== undefined) {
      const value = Number(dto.autoXmlConfidenceThreshold);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new BadRequestException(
          'autoXmlConfidenceThreshold must be a number between 0 and 1',
        );
      }
      data.autoXmlConfidenceThreshold = value;
    }

    if (dto.xmlConfirmationEnabled !== undefined) {
      data.xmlConfirmationEnabled = Boolean(dto.xmlConfirmationEnabled);
    }
    const normSubject = (v: unknown) => {
      const s = (v ?? '').toString().trim();
      return s ? s.slice(0, 300) : null;
    };
    const normBody = (v: unknown) => {
      const b = (v ?? '').toString();
      return b.trim() ? b.slice(0, 5000) : null;
    };

    if (dto.xmlConfirmationSubject !== undefined) {
      data.xmlConfirmationSubject = normSubject(dto.xmlConfirmationSubject);
    }
    if (dto.xmlConfirmationBody !== undefined) {
      data.xmlConfirmationBody = normBody(dto.xmlConfirmationBody);
    }
    if (dto.xmlConfirmationSubjectEn !== undefined) {
      data.xmlConfirmationSubjectEn = normSubject(dto.xmlConfirmationSubjectEn);
    }
    if (dto.xmlConfirmationBodyEn !== undefined) {
      data.xmlConfirmationBodyEn = normBody(dto.xmlConfirmationBodyEn);
    }
    if (dto.xmlConfirmationSubjectDe !== undefined) {
      data.xmlConfirmationSubjectDe = normSubject(dto.xmlConfirmationSubjectDe);
    }
    if (dto.xmlConfirmationBodyDe !== undefined) {
      data.xmlConfirmationBodyDe = normBody(dto.xmlConfirmationBodyDe);
    }

    return this.prismaService.systemSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: data,
    });
  }

  async isAutoSyncEnabled() {
    try {
      const settings = await this.get();
      return settings.syncMode === 'AUTOMATIC';
    } catch {
      // Safe default (e.g. before the migration is applied): no auto-sync.
      return false;
    }
  }

  /**
   * Whether a completed order may be delivered to Creative Gears automatically,
   * based on the current operation mode. MANUAL never auto-delivers; SELECTIVE
   * only when confidence meets the threshold; AUTONOMOUS always. Any error
   * (e.g. settings table not migrated yet) falls back to MANUAL, so the system
   * never auto-sends to Creative Gears by accident.
   */
  async shouldAutoDeliver(overallConfidence: number | null | undefined) {
    try {
      const settings = await this.get();

      if (settings.deliveryMode === 'AUTONOMOUS') return true;
      if (settings.deliveryMode === 'SELECTIVE') {
        return (
          typeof overallConfidence === 'number' &&
          overallConfidence >= settings.autoXmlConfidenceThreshold
        );
      }
      return false; // MANUAL
    } catch {
      return false;
    }
  }

  /**
   * XML-sent confirmation resolved for the customer e-mail's language (Niek-
   * editable, Renato 2026-10-08). The Dutch template is the base; English and
   * German are optional overrides. For the given language we use its Subject/Body
   * when filled, otherwise fall back to the Dutch one (and the Dutch body itself
   * falls back to the built-in default). Safe defaults on any error.
   */
  async getXmlConfirmationConfig(language?: string | null): Promise<{
    enabled: boolean;
    subject: string | null;
    body: string;
    lang: ConfirmationLang;
  }> {
    try {
      const s = await this.get();
      const requested = normalizeConfirmationLang(language);

      const nlSubject = (s.xmlConfirmationSubject ?? '').trim();
      const nlBody = (s.xmlConfirmationBody ?? '').trim();

      const subjectByLang: Record<ConfirmationLang, string> = {
        nl: nlSubject,
        en: (s.xmlConfirmationSubjectEn ?? '').trim(),
        de: (s.xmlConfirmationSubjectDe ?? '').trim(),
      };
      const bodyByLang: Record<ConfirmationLang, string> = {
        nl: nlBody,
        en: (s.xmlConfirmationBodyEn ?? '').trim(),
        de: (s.xmlConfirmationBodyDe ?? '').trim(),
      };

      // The body actually sent decides the greeting language: if the requested
      // language has no template, we fall back to Dutch and the greeting must be
      // Dutch too, so it matches the body.
      const resolvedLang: ConfirmationLang = bodyByLang[requested] ? requested : 'nl';

      return {
        enabled: Boolean(s.xmlConfirmationEnabled),
        // Subject may legitimately be null (= reply in the original thread).
        subject: subjectByLang[resolvedLang] || nlSubject || null,
        // Body always resolves to something: resolved lang -> built-in default.
        body: bodyByLang[resolvedLang] || DEFAULT_XML_CONFIRMATION_BODY,
        lang: resolvedLang,
      };
    } catch {
      return {
        enabled: false,
        subject: null,
        body: DEFAULT_XML_CONFIRMATION_BODY,
        lang: 'nl',
      };
    }
  }
}
