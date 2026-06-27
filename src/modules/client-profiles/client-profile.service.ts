import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLIENT_PROFILES } from './client-profiles';
import {
  ClientProfile,
  emailDomain,
} from './client-profile.types';

/** Any email-looking token, used to recover the original sender of a forward. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

@Injectable()
export class ClientProfileService {
  private readonly logger = new Logger(ClientProfileService.name);
  private readonly profiles: ClientProfile[] = CLIENT_PROFILES;

  constructor(private readonly configService?: ConfigService) {}

  /**
   * The per-client rules engine is OFF by default while the new flow (the AI
   * handles classification/split/extraction from the .eml) is in place. Flip
   * CLIENT_PROFILE_ENABLED=true to re-enable it.
   */
  enabled(): boolean {
    const raw = (
      this.configService?.get<string>('CLIENT_PROFILE_ENABLED') ?? ''
    ).trim();
    return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
  }

  /** All registered profiles (read-only). */
  all(): ClientProfile[] {
    return this.profiles;
  }

  byId(id: string): ClientProfile | null {
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  /**
   * Resolve the client profile for an incoming message. Tries the direct sender
   * first, then any address found in the body — so a Derix order forwarded by a
   * Pultrum mailbox still resolves to Derix (not to the forwarder).
   */
  resolve(input: {
    fromEmail?: string | null;
    bodyText?: string | null;
    /** Document/combined text, used for content-based recognition. */
    text?: string | null;
  }): ClientProfile | null {
    // Rules engine disabled -> no client is ever resolved.
    if (!this.enabled()) return null;

    // 1) Direct sender: match by exact address OR domain.
    const direct = (input.fromEmail ?? '').toLowerCase().trim();
    if (direct) {
      for (const profile of this.profiles) {
        if (this.matches(profile, direct, true)) {
          this.logger.log(`Resolved client profile '${profile.id}' from sender`);
          return profile;
        }
      }
    }

    // 2) Forwarded original sender from the body: match the EXACT address only.
    // A domain merely mentioned in a signature/quote/CC must NOT misattribute
    // the whole message (which would inject the wrong client's fixed data).
    const bodyEmails = [
      ...(input.bodyText ?? '').matchAll(EMAIL_RE),
    ].map((m) => m[0].toLowerCase());
    for (const email of bodyEmails) {
      for (const profile of this.profiles) {
        if (this.matches(profile, email, false)) {
          this.logger.log(
            `Resolved client profile '${profile.id}' from a forwarded sender`,
          );
          return profile;
        }
      }
    }

    // 3) Recognize by document content markers (forwarded mail / test sends).
    const content = [input.text, input.bodyText].filter(Boolean).join('\n');
    if (content.trim()) {
      for (const profile of this.profiles) {
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
    return markers.every((m) => {
      try {
        return new RegExp(m, 'i').test(content);
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
    const emails = (profile.match.emails ?? []).map((e) => e.toLowerCase());
    if (emails.includes(email)) return true;
    if (!allowDomain) return false;
    const domains = (profile.match.domains ?? []).map((d) => d.toLowerCase());
    return domains.includes(emailDomain(email));
  }

  /**
   * Deterministically derive field values for ONE order's text using the
   * profile: fixed constants, reference patterns and value maps. Intended to
   * run per order (whole email for a single order, or per-order text once a
   * batch is split). Returns only the fields it can fill.
   */
  derive(profile: ClientProfile, text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const haystack = text || '';

    // Always-the-same constants (e.g. Derix loading address).
    if (profile.fixedFields) Object.assign(out, profile.fixedFields);

    // Reference patterns: first capture group (or whole match) wins.
    for (const [key, pattern] of Object.entries(
      profile.referencePatterns ?? {},
    )) {
      try {
        const m = new RegExp(pattern, 'i').exec(haystack);
        if (m) out[key] = (m[1] ?? m[0]).trim();
      } catch {
        this.logger.warn(`Invalid reference pattern for ${profile.id}.${key}`);
      }
    }

    // Value maps: if a source term appears in the text, set the mapped value.
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

  /** Serializable summary to inject into the AI extraction payload. */
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
}
