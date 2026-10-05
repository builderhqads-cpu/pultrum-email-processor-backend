import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldRequirement, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DocumentTypeRuleCategory,
  normalizeDocumentTypeRules,
  normalizeXmlAttachmentCategories,
} from '../../utils/xml-documents';
import {
  getRuleRequirement,
  TRANSPORT_BOOKING_FIELD_RULES,
} from '../required-fields/transport-booking-field-rules';
import { CLIENT_PROFILES } from './client-profiles';
import {
  ClientProfile,
  emailDomain,
} from './client-profile.types';

/** Any email-looking token, used to recover the original sender of a forward. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

type CustomerProfileFieldInput = {
  key: string;
  value: string;
};

type CustomerProfileMutationInput = {
  name: string;
  /** Renato 2026-10-05: optional — a profile can be created with only a name. */
  contactEmail: string | null;
  additionalContactEmails: string[];
  active: boolean;
  notes: string | null;
  /** Free-text guidance for the AI about this customer's documents. */
  aiInstructions: string | null;
  fields: CustomerProfileFieldInput[];
  /**
   * Sander: pin the Transpas documenttype per file-type category
   * (pdf/word/excel/image) for this customer, overriding the AI. null = clear.
   */
  documentTypeRules: Partial<Record<DocumentTypeRuleCategory, string>> | null;
  /**
   * Renato 2026-10-05: per-customer switches for which ATTACHMENT file types are
   * embedded in the XML. Absent category = included (default = all on). The
   * original e-mail (.eml) is always sent and never affected. null = clear.
   */
  xmlAttachmentCategories: Partial<
    Record<DocumentTypeRuleCategory, boolean>
  > | null;
  /**
   * Niek/Derix: fill an empty invoice_reference with the order's TR number.
   * Per-customer; off by default.
   */
  invoiceReferenceFallbackToTr: boolean;
};

type CustomerProfileRecord = Awaited<
  ReturnType<ClientProfileService['fetchProfileRecordOrNull']>
>;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeValue = (value: string) => value.trim();
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A bare domain (no local part), e.g. "derix.de". Niek: an extra-email entry
// may be a whole domain so any sender from that company matches the profile.
const DOMAIN_FORMAT_RE = /^[^\s@]+\.[^\s@]+$/;

/**
 * Split profile-match entries into full e-mails and bare domains. Domain
 * entries are stored as "@domain"; here the leading "@" is stripped so they
 * land in `match.domains` (which only matches the direct sender — see matches()).
 * Entries without a leading "@" stay as exact e-mail matches (unchanged).
 */
function buildProfileMatch(entries: Array<string | null | undefined>): {
  emails: string[];
  domains: string[];
} {
  const emails: string[] = [];
  const domains: string[] = [];
  for (const raw of entries) {
    const entry = (raw ?? '').toLowerCase().trim();
    if (!entry) continue;
    if (entry.startsWith('@')) domains.push(entry.slice(1));
    else emails.push(entry);
  }
  return { emails, domains };
}

// Fields whose group can't be derived from the key prefix (Niek 2026-08-07).
// driver_*_info start with "driver_", not "pickup_"/"delivery_", so they'd fall
// into 'general'. Niek/Sander: Chauffeur laadinfo -> Laden, losinfo -> Lossen.
const PICKUP_EXTRA = new Set([
  'neutral_pickup_address',
  'neutral_loading',
  'driver_pickup_info',
]);
const DELIVERY_EXTRA = new Set([
  'neutral_delivery_address',
  'neutral_unloading',
  'driver_delivery_info',
]);
const CARGO_EXTRA = new Set([
  'length',
  'width',
  'height',
  'product_id',
  'product_description',
  'pallet_places',
  'adr_class',
  'dangerous_goods',
  'product_instructions',
  'adr',
]);

function fieldGroup(key: string) {
  if (key.startsWith('pickup_') || PICKUP_EXTRA.has(key)) return 'pickup';
  if (key.startsWith('delivery_') || DELIVERY_EXTRA.has(key)) return 'delivery';
  if (key.startsWith('cargo_') || key.startsWith('goods_') || CARGO_EXTRA.has(key))
    return 'cargo';
  return 'general';
}

function isAllowedInProfile(key: string) {
  const rule = TRANSPORT_BOOKING_FIELD_RULES.find((item) => item.key === key);
  if (!rule) return false;
  if (rule.generated || rule.calculable) return false;
  return true;
}

function toFieldMap(fields: Array<{ key: string; value?: string | null }>) {
  const out: Record<string, string> = {};
  for (const field of fields ?? []) {
    const key = (field?.key ?? '').trim();
    const value = normalizeValue(field?.value ?? '');
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}


@Injectable()
export class ClientProfileService implements OnModuleInit {
  private readonly logger = new Logger(ClientProfileService.name);
  private readonly staticProfiles: ClientProfile[] = CLIENT_PROFILES;
  private databaseProfiles: ClientProfile[] = [];

  constructor(
    private readonly configService?: ConfigService,
    private readonly prismaService?: PrismaService,
  ) {}

  async onModuleInit() {
    await this.refreshDatabaseProfiles().catch((error: any) => {
      this.logger.warn(
        `Failed to warm customer profile cache: ${error?.message ?? error}`,
      );
    });
  }

  /**
   * Legacy switch for the in-repo static profiles. Database-backed customer
   * profiles remain active regardless of this flag.
   */
  enabled(): boolean {
    const raw = (
      this.configService?.get<string>('CLIENT_PROFILE_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  /** Database-backed profiles first, then static profiles if explicitly enabled. */
  all(): ClientProfile[] {
    return [
      ...this.databaseProfiles,
      ...(this.enabled() ? this.staticProfiles : []),
    ];
  }

  byId(id: string): ClientProfile | null {
    return this.all().find((p) => p.id === id) ?? null;
  }

  async refreshDatabaseProfiles() {
    if (!this.prismaService) {
      this.databaseProfiles = [];
      return;
    }

    const profiles = await this.prismaService.customerProfile.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
      include: {
        emails: {
          orderBy: { email: 'asc' },
        },
        fields: {
          orderBy: { key: 'asc' },
        },
      },
    });

      this.databaseProfiles = profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      match: buildProfileMatch([
        profile.contactEmail,
        ...profile.emails.map((entry) => entry.email),
      ]),
      fixedFields: toFieldMap(profile.fields),
      aiInstructions: normalizeValue(profile.aiInstructions ?? '') || undefined,
      invoiceReferenceFallbackToTr: profile.invoiceReferenceFallbackToTr,
      notes: profile.notes ?? undefined,
    }));
  }

  /**
   * Resolve the client profile for an incoming message. Tries the direct sender
   * first, then any address found in the body, then content markers.
   */
  resolve(input: {
    fromEmail?: string | null;
    bodyText?: string | null;
    text?: string | null;
  }): ClientProfile | null {
    const profiles = this.all();
    if (profiles.length === 0) return null;

    const direct = (input.fromEmail ?? '').toLowerCase().trim();
    if (direct) {
      for (const profile of profiles) {
        if (this.matches(profile, direct, true)) {
          this.logger.log(`Resolved client profile '${profile.id}' from sender`);
          return profile;
        }
      }
    }

    const bodyEmails = [
      ...(input.bodyText ?? '').matchAll(EMAIL_RE),
    ].map((m) => m[0].toLowerCase());
    for (const email of bodyEmails) {
      for (const profile of profiles) {
        if (this.matches(profile, email, false)) {
          this.logger.log(
            `Resolved client profile '${profile.id}' from a forwarded sender`,
          );
          return profile;
        }
      }
    }

    const content = [input.text, input.bodyText].filter(Boolean).join('\n');
    if (content.trim()) {
      for (const profile of profiles) {
        if (this.matchesContent(profile, content)) {
          this.logger.log(
            `Resolved client profile '${profile.id}' from content markers`,
          );
          return profile;
        }
      }
    }
    return null;
  }

  /**
   * Normalize a company name for opdrachtgever matching: strip accents,
   * uppercase, drop dots (so "B.V." == "BV"), turn any other punctuation into a
   * single space, collapse whitespace. Deliberately conservative — we compare
   * for EQUALITY after this, never fuzzily.
   */
  private normalizeCompanyName(value: string | null | undefined): string {
    return (value ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .toUpperCase()
      .replace(/\./g, '') // B.V. -> BV
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * #3 (Niek/Van Losser): resolve the client from the order's `opdrachtgever`
   * (the ordering company as written in the PDF), so one e-mail carrying orders
   * for several customers maps each order to the right profile / customer_id.
   *
   * Curated + normalized-EXACT match against each profile's name — never fuzzy,
   * and an ambiguous name (matching >1 profile) resolves to null. Rationale: a
   * wrong match attributes the order to the wrong customer_id / financial
   * relation in Transpas, which is worse than leaving it unresolved (the caller
   * then flags it for the operator). Returns null when there is no single
   * confident match.
   */
  resolveByOpdrachtgever(
    opdrachtgever: string | null | undefined,
  ): ClientProfile | null {
    const target = this.normalizeCompanyName(opdrachtgever);
    if (!target) return null;

    const hits = this.all().filter(
      (profile) => this.normalizeCompanyName(profile.name) === target,
    );

    if (hits.length === 1) {
      this.logger.log(
        `Resolved client profile '${hits[0].id}' from opdrachtgever '${opdrachtgever}'`,
      );
      return hits[0];
    }
    if (hits.length > 1) {
      this.logger.warn(
        `Opdrachtgever '${opdrachtgever}' matched ${hits.length} profiles; leaving unresolved (needs a unique name).`,
      );
    }
    return null;
  }

  private matchesContent(profile: ClientProfile, content: string): boolean {
    const markers = profile.match.contentMarkers ?? [];
    if (markers.length === 0) return false;
    return markers.every((marker) => {
      try {
        return new RegExp(marker, 'i').test(content);
      } catch {
        return false;
      }
    });
  }

  private matches(
    profile: ClientProfile,
    email: string,
    allowDomain: boolean,
  ): boolean {
    const emails = (profile.match.emails ?? []).map((entry) =>
      entry.toLowerCase(),
    );
    if (emails.includes(email)) return true;
    if (!allowDomain) return false;
    const domains = (profile.match.domains ?? []).map((entry) =>
      entry.toLowerCase(),
    );
    return domains.includes(emailDomain(email));
  }

  derive(profile: ClientProfile, text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const haystack = text || '';

    if (profile.fixedFields) Object.assign(out, profile.fixedFields);

    for (const [key, pattern] of Object.entries(
      profile.referencePatterns ?? {},
    )) {
      try {
        const match = new RegExp(pattern, 'i').exec(haystack);
        if (match) out[key] = (match[1] ?? match[0]).trim();
      } catch {
        this.logger.warn(`Invalid reference pattern for ${profile.id}.${key}`);
      }
    }

    for (const [key, map] of Object.entries(profile.valueMaps ?? {})) {
      for (const [from, to] of Object.entries(map)) {
        if (from && haystack.toLowerCase().includes(from.toLowerCase())) {
          out[key] = to;
          break;
        }
      }
    }

    return out;
  }

  payloadSummary(profile: ClientProfile) {
    return {
      id: profile.id,
      name: profile.name,
      fixedFields: profile.fixedFields ?? {},
      referencePatterns: profile.referencePatterns ?? {},
      valueMaps: profile.valueMaps ?? {},
      split: profile.split ?? null,
    };
  }

  getFieldCatalog() {
    return TRANSPORT_BOOKING_FIELD_RULES.filter((rule) =>
      isAllowedInProfile(rule.key),
    ).map((rule) => ({
      key: rule.key,
      label: rule.label,
      requirement: getRuleRequirement(rule),
      group: fieldGroup(rule.key),
      conditional: Boolean(rule.conditional),
      aliases: rule.aliases ?? [],
    }));
  }

  async listCustomerProfiles() {
    this.requirePrisma();

    const profiles = await this.prismaService!.customerProfile.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        emails: {
          orderBy: { email: 'asc' },
        },
        fields: {
          orderBy: { key: 'asc' },
        },
      },
    });

    return profiles.map((profile) => this.serializeCustomerProfile(profile));
  }

  async getCustomerProfile(id: string) {
    const profile = await this.fetchProfileRecordOrNull(id);
    if (!profile) {
      throw new NotFoundException(`Customer profile not found: id=${id}`);
    }
    return this.serializeCustomerProfile(profile);
  }

  async createCustomerProfile(input: CustomerProfileMutationInput) {
    this.requirePrisma();
    await this.assertEmailsAvailable(
      [input.contactEmail, ...input.additionalContactEmails],
      null,
    );

    const profile = await this.prismaService!.$transaction(async (tx) => {
      const created = await tx.customerProfile.create({
        data: {
          name: input.name,
          contactEmail: input.contactEmail,
          active: input.active,
          notes: input.notes,
          aiInstructions: input.aiInstructions,
          invoiceReferenceFallbackToTr: input.invoiceReferenceFallbackToTr,
          ...(input.documentTypeRules
            ? { documentTypeRules: input.documentTypeRules }
            : {}),
          ...(input.xmlAttachmentCategories
            ? { xmlAttachmentCategories: input.xmlAttachmentCategories }
            : {}),
        },
      });

      if (input.additionalContactEmails.length) {
        await tx.customerProfileEmail.createMany({
          data: input.additionalContactEmails.map((email) => ({
            profileId: created.id,
            email,
          })),
        });
      }

      if (input.fields.length) {
        await tx.customerProfileField.createMany({
          data: input.fields.map((field) => ({
            profileId: created.id,
            key: field.key,
            value: field.value || null,
          })),
        });
      }

      return tx.customerProfile.findUnique({
        where: { id: created.id },
        include: {
          emails: {
            orderBy: { email: 'asc' },
          },
          fields: {
            orderBy: { key: 'asc' },
          },
        },
      });
    });

    if (!profile) {
      throw new NotFoundException('Customer profile could not be reloaded.');
    }

    await this.refreshDatabaseProfiles();
    return this.serializeCustomerProfile(profile);
  }

  async updateCustomerProfile(
    id: string,
    input: Partial<CustomerProfileMutationInput>,
  ) {
    this.requirePrisma();

    const existing = await this.fetchProfileRecordOrNull(id);
    if (!existing) {
      throw new NotFoundException(`Customer profile not found: id=${id}`);
    }

    // Renato 2026-10-05: distinguish "clear" (contactEmail === null) from
    // "unchanged" (undefined) — `??` would wrongly keep the old e-mail on clear.
    const nextPrimaryEmail =
      input.contactEmail !== undefined
        ? input.contactEmail
        : existing.contactEmail;
    const nextAdditionalEmails = [
      ...new Set(
        (input.additionalContactEmails ?? existing.emails.map((entry) => entry.email)).filter(
          (email) => email !== nextPrimaryEmail,
        ),
      ),
    ];

    await this.assertEmailsAvailable(
      [nextPrimaryEmail, ...nextAdditionalEmails],
      id,
    );

    const profile = await this.prismaService!.$transaction(async (tx) => {
      await tx.customerProfile.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.contactEmail !== undefined
            ? { contactEmail: input.contactEmail }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.aiInstructions !== undefined
            ? { aiInstructions: input.aiInstructions }
            : {}),
          ...(input.invoiceReferenceFallbackToTr !== undefined
            ? { invoiceReferenceFallbackToTr: input.invoiceReferenceFallbackToTr }
            : {}),
          ...(input.documentTypeRules !== undefined
            ? {
                documentTypeRules:
                  input.documentTypeRules ?? Prisma.DbNull,
              }
            : {}),
          ...(input.xmlAttachmentCategories !== undefined
            ? {
                xmlAttachmentCategories:
                  input.xmlAttachmentCategories ?? Prisma.DbNull,
              }
            : {}),
        },
      });

      if (input.additionalContactEmails !== undefined) {
        await tx.customerProfileEmail.deleteMany({
          where: { profileId: id },
        });

        if (nextAdditionalEmails.length) {
          await tx.customerProfileEmail.createMany({
            data: nextAdditionalEmails.map((email) => ({
              profileId: id,
              email,
            })),
          });
        }
      }

      if (input.fields !== undefined) {
        await tx.customerProfileField.deleteMany({
          where: { profileId: id },
        });

        if (input.fields.length) {
          await tx.customerProfileField.createMany({
            data: input.fields.map((field) => ({
              profileId: id,
              key: field.key,
              value: field.value,
            })),
          });
        }
      }

      return tx.customerProfile.findUnique({
        where: { id },
        include: {
          emails: {
            orderBy: { email: 'asc' },
          },
          fields: {
            orderBy: { key: 'asc' },
          },
        },
      });
    });

    if (!profile) {
      throw new NotFoundException('Customer profile could not be reloaded.');
    }

    await this.refreshDatabaseProfiles();
    return this.serializeCustomerProfile(profile);
  }

  async deleteCustomerProfile(id: string) {
    this.requirePrisma();

    const existing = await this.fetchProfileRecordOrNull(id);
    if (!existing) {
      throw new NotFoundException(`Customer profile not found: id=${id}`);
    }

    await this.prismaService!.customerProfile.delete({
      where: { id },
    });

    await this.refreshDatabaseProfiles();

    return {
      ok: true,
      deletedCustomerProfileId: existing.id,
      deletedCustomerProfileEmail: existing.contactEmail,
    };
  }

  private async fetchProfileRecordOrNull(id: string) {
    this.requirePrisma();

    return this.prismaService!.customerProfile.findUnique({
      where: { id },
      include: {
        emails: {
          orderBy: { email: 'asc' },
        },
        fields: {
          orderBy: { key: 'asc' },
        },
      },
    });
  }

  private serializeCustomerProfile(profile: NonNullable<CustomerProfileRecord>) {
    const catalogByKey = new Map(
      this.getFieldCatalog().map((field) => [field.key, field]),
    );

    return {
      id: profile.id,
      name: profile.name,
      contactEmail: profile.contactEmail,
      additionalContactEmails: profile.emails.map((entry) => entry.email),
      contactEmails: [
        profile.contactEmail,
        ...profile.emails.map((entry) => entry.email),
      ].filter((e): e is string => Boolean(e)),
      active: profile.active,
      notes: profile.notes,
      aiInstructions: profile.aiInstructions ?? '',
      documentTypeRules: normalizeDocumentTypeRules(profile.documentTypeRules),
      xmlAttachmentCategories: normalizeXmlAttachmentCategories(
        profile.xmlAttachmentCategories,
      ),
      invoiceReferenceFallbackToTr: profile.invoiceReferenceFallbackToTr,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      fields: profile.fields.map((field) => ({
        id: field.id,
        key: field.key,
        value: field.value ?? '',
        label: catalogByKey.get(field.key)?.label ?? field.key,
        requirement:
          catalogByKey.get(field.key)?.requirement ?? FieldRequirement.OPTIONAL,
        group: catalogByKey.get(field.key)?.group ?? fieldGroup(field.key),
      })),
    };
  }

  private requirePrisma() {
    if (!this.prismaService) {
      throw new BadRequestException(
        'Prisma service is not available in this context.',
      );
    }
  }

  normalizeMutationInput(input: {
    name?: unknown;
    contactEmail?: unknown;
    additionalContactEmails?: unknown;
    active?: unknown;
    notes?: unknown;
    aiInstructions?: unknown;
    fields?: unknown;
    documentTypeRules?: unknown;
    xmlAttachmentCategories?: unknown;
    invoiceReferenceFallbackToTr?: unknown;
  }): CustomerProfileMutationInput {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new BadRequestException('Customer profile name is required.');
    }

    // Renato 2026-10-05: contact e-mail is OPTIONAL — a profile can be created
    // with only a name (matched by opdrachtgever/content). When present it must
    // be a valid e-mail; when absent/empty it is stored as null.
    let contactEmail: string | null = null;
    if (typeof input.contactEmail === 'string' && input.contactEmail.trim()) {
      contactEmail = normalizeEmail(input.contactEmail);
      if (!EMAIL_FORMAT_RE.test(contactEmail)) {
        throw new BadRequestException(
          'Customer profile contact email is invalid.',
        );
      }
    }

    const additionalContactEmails = this.normalizeAdditionalContactEmails(
      input.additionalContactEmails,
      contactEmail ?? undefined,
    );

    if (input.active !== undefined && typeof input.active !== 'boolean') {
      throw new BadRequestException(
        'Customer profile active must be a boolean.',
      );
    }

    const active = input.active === undefined ? true : input.active;
    const notes =
      typeof input.notes === 'string' && input.notes.trim()
        ? input.notes.trim()
        : null;

    const aiInstructions =
      typeof input.aiInstructions === 'string' && input.aiInstructions.trim()
        ? input.aiInstructions.trim()
        : null;

    const rawFields = Array.isArray(input.fields) ? input.fields : [];
    const unique = new Map<string, CustomerProfileFieldInput>();
    for (const rawField of rawFields) {
      if (!rawField || typeof rawField !== 'object') continue;
      const key = ((rawField as any).key ?? '').toString().trim();
      const value = normalizeValue(((rawField as any).value ?? '').toString());
      if (!key || !value) continue;
      if (!isAllowedInProfile(key)) {
        throw new BadRequestException(
          `Field is not allowed in customer profiles: ${key}`,
        );
      }
      unique.set(key, { key, value });
    }

    const documentTypeRules = normalizeDocumentTypeRules(
      input.documentTypeRules,
    );

    const xmlAttachmentCategories = normalizeXmlAttachmentCategories(
      input.xmlAttachmentCategories,
    );

    if (
      input.invoiceReferenceFallbackToTr !== undefined &&
      typeof input.invoiceReferenceFallbackToTr !== 'boolean'
    ) {
      throw new BadRequestException(
        'invoiceReferenceFallbackToTr must be a boolean.',
      );
    }

    return {
      name: input.name.trim(),
      contactEmail,
      additionalContactEmails,
      active,
      notes,
      aiInstructions,
      fields: [...unique.values()],
      documentTypeRules: Object.keys(documentTypeRules).length
        ? documentTypeRules
        : null,
      xmlAttachmentCategories: Object.keys(xmlAttachmentCategories).length
        ? xmlAttachmentCategories
        : null,
      invoiceReferenceFallbackToTr:
        input.invoiceReferenceFallbackToTr === true,
    };
  }

  normalizePartialMutationInput(input: {
    name?: unknown;
    contactEmail?: unknown;
    additionalContactEmails?: unknown;
    active?: unknown;
    notes?: unknown;
    aiInstructions?: unknown;
    fields?: unknown;
    documentTypeRules?: unknown;
    xmlAttachmentCategories?: unknown;
    invoiceReferenceFallbackToTr?: unknown;
  }) {
    const out: Partial<CustomerProfileMutationInput> = {};

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new BadRequestException('Customer profile name is invalid.');
      }
      out.name = input.name.trim();
    }

    if (input.contactEmail !== undefined) {
      // Renato 2026-10-05: an empty/null contact e-mail CLEARS it (the profile is
      // then matched by name/opdrachtgever). A non-empty value must be valid.
      const raw = input.contactEmail;
      if (typeof raw === 'string' && raw.trim()) {
        const contactEmail = normalizeEmail(raw);
        if (!EMAIL_FORMAT_RE.test(contactEmail)) {
          throw new BadRequestException(
            'Customer profile contact email is invalid.',
          );
        }
        out.contactEmail = contactEmail;
      } else if (raw === null || (typeof raw === 'string' && !raw.trim())) {
        out.contactEmail = null;
      } else {
        throw new BadRequestException(
          'Customer profile contact email is invalid.',
        );
      }
    }

    if (input.additionalContactEmails !== undefined) {
      out.additionalContactEmails = this.normalizeAdditionalContactEmails(
        input.additionalContactEmails,
        typeof out.contactEmail === 'string' ? out.contactEmail : undefined,
      );
    }

    if (input.active !== undefined) {
      if (typeof input.active !== 'boolean') {
        throw new BadRequestException(
          'Customer profile active must be a boolean.',
        );
      }
      out.active = input.active;
    }

    if (input.notes !== undefined) {
      out.notes =
        typeof input.notes === 'string' && input.notes.trim()
          ? input.notes.trim()
          : null;
    }

    if (input.aiInstructions !== undefined) {
      out.aiInstructions =
        typeof input.aiInstructions === 'string' && input.aiInstructions.trim()
          ? input.aiInstructions.trim()
          : null;
    }

    if (input.fields !== undefined) {
      if (!Array.isArray(input.fields)) {
        throw new BadRequestException(
          'Customer profile fields must be an array.',
        );
      }

      const unique = new Map<string, CustomerProfileFieldInput>();
      for (const rawField of input.fields) {
        if (!rawField || typeof rawField !== 'object') continue;
        const key = ((rawField as any).key ?? '').toString().trim();
        const value = normalizeValue(((rawField as any).value ?? '').toString());
        if (!key || !value) continue;
        if (!isAllowedInProfile(key)) {
          throw new BadRequestException(
            `Field is not allowed in customer profiles: ${key}`,
          );
        }
        unique.set(key, { key, value });
      }

      out.fields = [...unique.values()];
    }

    if (input.documentTypeRules !== undefined) {
      const rules = normalizeDocumentTypeRules(input.documentTypeRules);
      out.documentTypeRules = Object.keys(rules).length ? rules : null;
    }

    if (input.xmlAttachmentCategories !== undefined) {
      const cats = normalizeXmlAttachmentCategories(
        input.xmlAttachmentCategories,
      );
      out.xmlAttachmentCategories = Object.keys(cats).length ? cats : null;
    }

    if (input.invoiceReferenceFallbackToTr !== undefined) {
      if (typeof input.invoiceReferenceFallbackToTr !== 'boolean') {
        throw new BadRequestException(
          'invoiceReferenceFallbackToTr must be a boolean.',
        );
      }
      out.invoiceReferenceFallbackToTr = input.invoiceReferenceFallbackToTr;
    }

    if (Object.keys(out).length === 0) {
      throw new BadRequestException(
        'No customer profile updates were provided.',
      );
    }

    return out;
  }

  private normalizeAdditionalContactEmails(
    rawValue: unknown,
    primaryEmail?: string,
  ) {
    if (rawValue === undefined) return [];
    if (!Array.isArray(rawValue)) {
      throw new BadRequestException(
        'Customer profile additional contact emails must be an array.',
      );
    }

    const normalized = new Set<string>();
    for (const entry of rawValue) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new BadRequestException(
          'Customer profile additional contact emails are invalid.',
        );
      }
      const value = normalizeEmail(entry);
      if (EMAIL_FORMAT_RE.test(value)) {
        // A full e-mail address (current behaviour, unchanged).
        if (primaryEmail && value === primaryEmail) continue;
        normalized.add(value);
        continue;
      }
      // Otherwise accept a bare domain ("derix.de" or "@derix.de") and store it
      // canonically as "@derix.de" so matching can tell it apart from an e-mail.
      const domain = value.replace(/^@/, '');
      if (DOMAIN_FORMAT_RE.test(domain)) {
        normalized.add(`@${domain}`);
        continue;
      }
      throw new BadRequestException(
        `Customer profile additional contact email is invalid: ${entry}`,
      );
    }

    return [...normalized.values()];
  }

  private async assertEmailsAvailable(
    emails: Array<string | null | undefined>,
    excludeProfileId: string | null,
  ) {
    const uniqueEmails = [
      ...new Set(
        emails
          .filter((e): e is string => typeof e === 'string' && !!e.trim())
          .map(normalizeEmail),
      ),
    ];
    // Renato 2026-10-05: zero e-mails is now ALLOWED — a profile can be created
    // with only a name (matched by opdrachtgever/content). Nothing to check then.
    if (!uniqueEmails.length) {
      return;
    }

    const primaryConflicts = await this.prismaService!.customerProfile.findMany({
      where: {
        contactEmail: { in: uniqueEmails },
        ...(excludeProfileId ? { id: { not: excludeProfileId } } : {}),
      },
      select: { id: true, contactEmail: true },
    });
    if (primaryConflicts.length) {
      throw new BadRequestException(
        `A customer profile with this contact email already exists: ${primaryConflicts[0]!.contactEmail}`,
      );
    }

    const additionalConflicts = await this.prismaService!.customerProfileEmail.findMany({
      where: {
        email: { in: uniqueEmails },
        ...(excludeProfileId ? { profileId: { not: excludeProfileId } } : {}),
      },
      select: { profileId: true, email: true },
    });
    if (additionalConflicts.length) {
      throw new BadRequestException(
        `A customer profile with this contact email already exists: ${additionalConflicts[0]!.email}`,
      );
    }
  }
}
