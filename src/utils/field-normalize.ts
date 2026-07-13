/**
 * Value-normalization helpers applied to extracted transport-booking field
 * values before they are stored and written to XML.
 *
 * Goals (from user feedback on extraction quality):
 *  - Quantity/unit amounts are whole integers, no comma/decimal ("1,00" -> "1").
 *  - Numeric "measure" fields (loadingmeter, volume, weight, ...) that are 0 or
 *    not informed go out BLANK, never "0".
 *  - A delivery/pickup name is never invented from the city.
 *  - An address holds street + number only; zipcode/city live in their own
 *    fields (conservative post-split when they leaked into the address).
 *
 * All helpers are pure and defensive: non-numeric values are left untouched
 * rather than destroyed.
 */

// Count fields -> whole integer.
const QUANTITY_KEYS = ['cargo_unit_amount', 'unit_amount', 'goods_unit_amount'];

// Numeric measure fields where 0 / not-informed must be blank, never "0".
const ZERO_TO_BLANK_KEYS = [
  'cargo_loading_meter',
  'goods_loading_meter',
  'cargo_volume',
  'goods_volume',
  'cargo_weight',
  'goods_weight',
  'weight',
  'length',
  'width',
  'height',
  'pallet_places',
  'price',
  'fixed_price',
];

/**
 * Robustly parse a decimal that may use European/German notation. Handles:
 *  - German/EU: "14.536,350" -> 14536.35  (dot = thousands, comma = decimal)
 *  - English:   "1,234.56"   -> 1234.56   (comma = thousands, dot = decimal)
 *  - Plain:     "12,5" -> 12.5 ; "1.234.567" -> 1234567 ; "120" -> 120
 *
 * Rule: when both separators are present, the rightmost one is the decimal.
 * With a single separator we fall back to EU-friendly heuristics. Returns null
 * for non-numeric input.
 */
export function parseDecimal(
  value: string | null | undefined,
): number | null {
  if (value == null) return null;
  const m = value.toString().match(/-?\d[\d.,]*\d|-?\d/);
  if (!m) return null;
  let s = m[0];

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const decSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    s = s.split(thouSep).join('').replace(decSep, '.');
  } else if (hasComma) {
    // Multiple commas => thousands grouping (1,234,567); single comma => decimal.
    s =
      (s.match(/,/g) || []).length > 1
        ? s.split(',').join('')
        : s.replace(',', '.');
  } else if (hasDot) {
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) {
      s = s.split('.').join(''); // 1.234.567 -> thousands grouping
    } else {
      // Single dot: "14.536" (3 digits, no leading zero) => thousands; else decimal.
      const after = s.split('.')[1] ?? '';
      if (after.length === 3 && !/^-?0\./.test(s)) s = s.split('.').join('');
    }
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Format a number as a clean string: integers plain, else up to 3 trimmed decimals. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Number.parseFloat(n.toFixed(3)));
}

/**
 * Convert a length to centimeters when an explicit unit is present
 * ("1200 mm" -> "120", "1,2 m" -> "120", "120 cm" -> "120"). Without a unit
 * the scale is unknown, so the value is only notation-normalized, not scaled.
 */
export function toCentimeters(value: string | null | undefined): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  const n = parseDecimal(v);
  if (n == null) return v; // non-numeric -> keep
  const lower = v.toLowerCase();
  if (/\bmm\b|millimet/.test(lower)) return formatNumber(n / 10);
  if (/\bcm\b|centimet/.test(lower)) return formatNumber(n);
  if (/\bm\b|\bmeter|\bmetre/.test(lower)) return formatNumber(n * 100);
  return formatNumber(n); // no unit -> keep scale, just clean notation
}

/** "1,00 st" / "2.0" -> "2"; non-numeric left as-is; empty -> "". */
export function normalizeQuantity(value: string | null | undefined): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  const n = parseDecimal(v);
  if (n == null) return v;
  return String(Math.round(n));
}

/**
 * Blank when the value is empty or numerically zero; otherwise return the
 * value as a clean number (fixes German notation, drops units like "kg").
 */
export function blankIfZero(value: string | null | undefined): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  const n = parseDecimal(v);
  if (n == null) return v; // non-numeric -> keep
  if (n === 0) return '';
  return formatNumber(n);
}

/**
 * Preserve already-normalized decimal strings (e.g. "16.333", "133.280")
 * produced by backend calculations. This avoids re-parsing them with the
 * locale heuristics that would otherwise interpret a single dot + 3 digits as
 * a thousands separator ("16.333" -> 16333).
 *
 * Use this only for values we already control/normalize internally.
 */
export function blankIfZeroPreservingDecimalString(
  value: string | null | undefined,
): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  if (/^-?0+(?:\.0+)?$/.test(v)) return '';
  if (/^-?\d+\.\d{1,3}$/.test(v)) return v;
  return blankIfZero(v);
}

/** Drop a name that merely echoes the city (AI substituting an empty field). */
export function dropNameIfCity(
  name: string | null | undefined,
  city: string | null | undefined,
): string {
  const n = (name ?? '').toString().trim();
  const c = (city ?? '').toString().trim();
  if (!n) return '';
  if (c && n.toLowerCase() === c.toLowerCase()) return '';
  return n;
}

/**
 * Conservative address split: only when the dedicated zipcode field is still
 * empty AND a clear postcode is embedded in the address, pull the postcode
 * (and trailing city) out and leave street + number in the address. Existing
 * city values win. If anything is ambiguous, the input is returned unchanged.
 */
export function splitStreetAddress(input: {
  address: string | null | undefined;
  zipcode: string | null | undefined;
  city: string | null | undefined;
}): { address: string; zipcode: string; city: string } {
  let address = (input.address ?? '').toString().trim();
  let zipcode = (input.zipcode ?? '').toString().trim();
  let city = (input.city ?? '').toString().trim();

  if (!address || zipcode) return { address, zipcode, city };

  // NL "1234 AB" (city optional) or DE "12345 City" (city required).
  const nl = address.match(/\b(\d{4}\s?[A-Za-z]{2})\b\s*(.*)$/);
  const de = address.match(/\b(\d{5})\s+([A-Za-zÄÖÜäöüß][^\d]*)$/);
  const m = nl || de;
  if (!m) return { address, zipcode, city };

  const idx = address.indexOf(m[1]);
  const head = address.slice(0, idx).replace(/[,;\s]+$/, '').trim();
  if (!head) return { address, zipcode, city }; // no real street part -> bail

  zipcode = m[1].replace(/\s+/, ' ').toUpperCase();
  const tail = (m[2] ?? '').replace(/^[,;\s]+/, '').trim();
  if (!city && tail) city = tail;
  address = head;
  return { address, zipcode, city };
}

/**
 * Apply all value-normalization rules in place to a field map. Run AFTER any
 * derivations/calculations that need the raw numeric values.
 */
export function normalizeFieldMap(map: Map<string, string>): void {
  // Dimensions -> centimeters (when a unit is present) before the zero check.
  for (const key of ['length', 'width', 'height']) {
    if (map.has(key)) map.set(key, toCentimeters(map.get(key)));
  }
  for (const key of QUANTITY_KEYS) {
    if (map.has(key)) map.set(key, normalizeQuantity(map.get(key)));
  }
  for (const key of ZERO_TO_BLANK_KEYS) {
    if (map.has(key)) map.set(key, blankIfZero(map.get(key)));
  }

  map.set(
    'pickup_name',
    dropNameIfCity(map.get('pickup_name'), map.get('pickup_city')),
  );
  map.set(
    'delivery_name',
    dropNameIfCity(map.get('delivery_name'), map.get('delivery_city')),
  );

  for (const side of ['pickup', 'delivery'] as const) {
    const split = splitStreetAddress({
      address: map.get(`${side}_address`),
      zipcode: map.get(`${side}_zipcode`),
      city: map.get(`${side}_city`),
    });
    map.set(`${side}_address`, split.address);
    map.set(`${side}_zipcode`, split.zipcode);
    map.set(`${side}_city`, split.city);
  }
}

/** Light 24h normalization: "5pm"->"17:00", "9.00 uur"->"09:00", "17:00"->"17:00". */
export function normalizeTime(raw: string | null | undefined): string {
  const v = (raw ?? '').toString().trim().toLowerCase();
  const m = v.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
  if (!m) return (raw ?? '').toString().trim();
  let h = Number.parseInt(m[1], 10);
  const min = m[2] ?? '00';
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (!Number.isFinite(h) || h > 23) return (raw ?? '').toString().trim();
  return `${String(h).padStart(2, '0')}:${min}`;
}

// A clock-time token: needs a colon/dot OR an explicit unit (avoids matching
// bare numbers like "until 5 boxes").
const TIME_RE =
  '(\\d{1,2}[:.]\\d{2}(?:\\s*(?:uur|u|h))?|\\d{1,2}\\s*(?:am|pm|uur|h))';
// Upper-bound words: the time is a deadline -> goes to *_time_till.
const UNTIL_RE = '(?:tot|t/m|until|by|before|uiterlijk|latest|voor|v[oó]or|at[ée]|no m[aá]ximo)';
// Lower-bound words: the time is a start -> goes to *_time.
const FROM_RE = '(?:vanaf|from|a partir de|desde|after|ab)';
const PICKUP_CTX = /(laad|laden|ophal|colet|collect|pick ?up|carrega)/i;
const DELIVERY_CTX = /(los|lossen|lever|aflever|entreg|deliver|descarreg|unload)/i;

/**
 * Route a clock time to the correct side of the window using the source text.
 * Clients often give only an upper bound ("deliver until 5pm" / "coletar até
 * 9h"); that value must land in *_time_till, not *_time. If the AI already put
 * it in the "from" (van) slot, it is moved. Pickup vs delivery is decided by
 * context words near the time. Ambiguous matches are left untouched.
 */
export function routeTimeBounds(
  fields: Record<string, unknown>,
  text: string | null | undefined,
): Record<string, unknown> {
  const out = { ...fields };
  const haystack = (text ?? '').toString();
  if (!haystack.trim()) return out;

  const apply = (kwRe: string, kind: 'till' | 'from') => {
    const re = new RegExp(`${kwRe}\\s+${TIME_RE}`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      const time = normalizeTime(m[1]);
      if (!/^\d{2}:\d{2}$/.test(time)) continue;
      const window = haystack.slice(
        Math.max(0, m.index - 60),
        m.index + m[0].length + 20,
      );
      const isPickup = PICKUP_CTX.test(window);
      const isDelivery = DELIVERY_CTX.test(window);
      if (isPickup === isDelivery) continue; // ambiguous / both / neither
      const side = isDelivery ? 'delivery' : 'pickup';
      const vanKey = `${side}_time`;
      const tillKey = `${side}_time_till`;
      if (kind === 'till') {
        out[tillKey] = time;
        // The AI misplaced the deadline into the "from" slot -> clear it.
        if (normalizeTime(String(out[vanKey] ?? '')) === time) out[vanKey] = '';
      } else {
        out[vanKey] = time;
      }
    }
  };

  apply(UNTIL_RE, 'till');
  apply(FROM_RE, 'from');
  return out;
}
