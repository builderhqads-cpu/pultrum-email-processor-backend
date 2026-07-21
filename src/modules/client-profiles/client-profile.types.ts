/**
 * Declarative per-client profile (the "knowledge base" entry for one customer).
 *
 * A profile is pure DATA — no logic — so it can start as a typed object in the
 * repo and later be moved to a database table + admin UI without changing the
 * engine that consumes it. The engine resolves a profile from the sender and
 * uses it to fill fixed fields, normalize references, map values and decide how
 * to split a batch deterministically. Clients WITHOUT a profile fall back to the
 * generic AI path.
 */
export interface ClientProfile {
  /** Stable slug, e.g. 'derix-wk'. */
  id: string;
  /** Human label / opdrachtgever name, e.g. 'Derix Westerkappeln'. */
  name: string;

  /**
   * How to recognize this client. Matched against the message sender AND, for
   * forwarded messages, against the original sender parsed from the body.
   */
  match: {
    /** Lower-cased domains, e.g. ['derix.de']. */
    domains?: string[];
    /** Specific full addresses, e.g. ['transporte.wk@derix.de']. */
    emails?: string[];
    /**
     * Regexes that must ALL appear in the document content to identify this
     * client even when the sender isn't theirs (forwarded mail, test sends).
     * Keep them specific to avoid matching other clients.
     */
    contentMarkers?: string[];
  };

  /**
   * Field values that are ALWAYS the same for this client (no extraction).
   * Keyed by transport-booking field key (e.g. pickup_address, pickup_city).
   */
  fixedFields?: Record<string, string>;

  /**
   * Per-field free-text hints describing HOW to find the value in THIS
   * customer's documents, keyed by field. Forwarded to the AI extraction route
   * so the model can follow the customer's own layout conventions — e.g.
   * pickup_reference -> "10-cijferig nummer dat TR bevat". Never a value.
   */
  fieldInstructions?: Record<string, string>;

  /**
   * Regex (as string) used to pull a reference out of the text, keyed by field.
   * First capture group (or full match) wins. E.g. invoice_reference -> the BA
   * number, pickup_reference -> the TR number.
   */
  referencePatterns?: Record<string, string>;

  /**
   * Value translation tables keyed by field. E.g. transport_type maps the
   * German "transportsoort" terms to Pultrum's values.
   */
  valueMaps?: Record<string, Record<string, string>>;

  /** How a multi-order document is divided into individual orders. */
  split?: {
    /** 'deterministic' uses a named strategy; 'ai' defers to the AI split route. */
    mode: 'deterministic' | 'ai';
    /** Strategy key for deterministic mode, e.g. 'derix-tr-lt'. */
    strategy?: string;
  };

  /**
   * Orders matching any of these are skipped (a third party handles them).
   * Currently inert until confirmed by the customer.
   */
  exclude?: {
    routePatterns?: string[];
    partnerPatterns?: string[];
  };

  /** Free-text notes for operators / future reference. */
  notes?: string;
}

/** Normalize an email/domain for matching. */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? '').toLowerCase().trim().split('@');
  return at.length === 2 ? at[1] : '';
}
