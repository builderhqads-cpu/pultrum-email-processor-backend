import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldRequirement } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
  contactEmail: string;
  additionalContactEmails: string[];
  active: boolean;
  notes: string | null;
  /** Free-text guidance for the AI about this customer's documents. */
  aiInstructions: string | null;
  fields: CustomerProfileFieldInput[];
};

type CustomerProfileRecord = Awaited<
  ReturnType<ClientProfileService['fetchProfileRecordOrNull']>
>;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeValue = (value: string) => value.trim();
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fieldGroup(key: string) {
  if (key.startsWith('pickup_')) return 'pickup';
  if (key.startsWith('delivery_')) return 'delivery';
  if (key.startsWith('cargo_') || key.startsWith('goods_')) return 'cargo';
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
      match: {
        emails: [profile.contactEmail, ...profile.emails.map((entry) => entry.email)],
      },
      fixedFields: toFieldMap(profile.fields),
      aiInstructions: normalizeValue(profile.aiInstructions ?? '') || undefined,
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

    const nextPrimaryEmail = input.contactEmail ?? existing.contactEmail;
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
      contactEmails: [profile.contactEmail, ...profile.emails.map((entry) => entry.email)],
      active: profile.active,
      notes: profile.notes,
      aiInstructions: profile.aiInstructions ?? '',
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
  }): CustomerProfileMutationInput {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new BadRequestException('Customer profile name is required.');
    }
    if (
      typeof input.contactEmail !== 'string' ||
      !input.contactEmail.trim()
    ) {
      throw new BadRequestException(
        'Customer profile contact email is required.',
      );
    }

    const contactEmail = normalizeEmail(input.contactEmail);
    const isValidEmail = EMAIL_FORMAT_RE.test(contactEmail);
    if (!isValidEmail) {
      throw new BadRequestException(
        'Customer profile contact email is invalid.',
      );
    }

    const additionalContactEmails = this.normalizeAdditionalContactEmails(
      input.additionalContactEmails,
      contactEmail,
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

    return {
      name: input.name.trim(),
      contactEmail,
      additionalContactEmails,
      active,
      notes,
      aiInstructions,
      fields: [...unique.values()],
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
  }) {
    const out: Partial<CustomerProfileMutationInput> = {};

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new BadRequestException('Customer profile name is invalid.');
      }
      out.name = input.name.trim();
    }

    if (input.contactEmail !== undefined) {
      if (
        typeof input.contactEmail !== 'string' ||
        !input.contactEmail.trim()
      ) {
        throw new BadRequestException(
          'Customer profile contact email is invalid.',
        );
      }
      const contactEmail = normalizeEmail(input.contactEmail);
      const isValidEmail = EMAIL_FORMAT_RE.test(contactEmail);
      if (!isValidEmail) {
        throw new BadRequestException(
          'Customer profile contact email is invalid.',
        );
      }
      out.contactEmail = contactEmail;
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
      const email = normalizeEmail(entry);
      if (!EMAIL_FORMAT_RE.test(email)) {
        throw new BadRequestException(
          `Customer profile additional contact email is invalid: ${entry}`,
        );
      }
      if (primaryEmail && email === primaryEmail) {
        continue;
      }
      normalized.add(email);
    }

    return [...normalized.values()];
  }

  private async assertEmailsAvailable(
    emails: string[],
    excludeProfileId: string | null,
  ) {
    const uniqueEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (!uniqueEmails.length) {
      throw new BadRequestException(
        'At least one customer profile email is required.',
      );
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
