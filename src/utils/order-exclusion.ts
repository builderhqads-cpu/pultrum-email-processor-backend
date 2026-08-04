/**
 * Parties Pultrum never transports. Derix Westerkappeln rule from Niek
 * (2026-07-29): "indien er orders zijn voor Withagen ... dan mag deze compleet
 * genegeerd worden. Deze order(s) voor Withagen hoeven wij nooit in te zetten."
 * Comma-separated, case-insensitive. Default: withagen.
 */
export function parseExcludedPartyNames(
  raw: string | undefined | null,
): string[] {
  // Unset OR blank falls back to the default, so the Withagen safety rule can't
  // be lost by simply clearing the variable.
  const value = (raw ?? '').trim() || 'withagen';
  return value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when an order must be dropped entirely because its delivery (or pickup)
 * party matches an excluded name. Matched on delivery_name first — the rule is
 * about orders *for* Withagen (the consignee) — plus pickup_name as a safety
 * net for the reverse direction.
 */
export function isExcludedParty(
  fields: Record<string, unknown> | null | undefined,
  excludedNames: string[],
): boolean {
  if (!fields || excludedNames.length === 0) return false;
  const partyNames = ['delivery_name', 'pickup_name']
    .map((key) => (fields[key] ?? '').toString().toLowerCase())
    .filter(Boolean);
  return partyNames.some((party) =>
    excludedNames.some((excluded) => party.includes(excluded)),
  );
}
