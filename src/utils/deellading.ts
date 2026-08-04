import { parseDecimal } from './field-normalize';

/**
 * Deellading (part-load) division. The AI splits one transport into N orders
 * (delivery rows), each tagged unit "deellading" with a shared reference base
 * and a distinct "-<n>" suffix (e.g. 25TR003132-1 .. -5), and carries the
 * transport's TOTAL weight/volume. We divide those totals by N here — exact
 * integer/decimal math — instead of letting the AI do the arithmetic (it is
 * unreliable) or letting the total's divided form trip the decimal parser.
 *
 * Length/width/height stay at the FULL total (Niek's rule): the footprint is
 * shared, only the goods weight and volume are per shipment.
 */

const WEIGHT_KEYS = ['cargo_weight', 'goods_weight'];
const VOLUME_KEYS = ['cargo_volume', 'goods_volume'];

type SplitOrder = {
  externalReference?: string | null;
  fields: Record<string, unknown>;
};

/** Strip a trailing "-<n>" / "_<n>" split suffix; null when there is none. */
export function deelladingBaseRef(
  ref: string | null | undefined,
): string | null {
  const value = (ref ?? '').toString().trim();
  const match = /^(.+?)[-_]\d+$/.exec(value);
  return match ? match[1] : null;
}

function isDeellading(fields: Record<string, unknown> | null | undefined) {
  const unit = (fields?.cargo_unit_id ?? fields?.unit_id ?? '')
    .toString()
    .trim()
    .toLowerCase();
  return unit === 'deellading';
}

function divideMeasure(
  fields: Record<string, unknown>,
  key: string,
  divisor: number,
  decimals: number,
) {
  const raw = fields[key];
  if (raw == null || raw.toString().trim() === '') return;
  const total = parseDecimal(raw.toString());
  if (total == null || !Number.isFinite(total)) return;
  const per = total / divisor;
  if (decimals === 0) {
    fields[key] = String(Math.round(per));
    return;
  }
  fields[key] = per.toFixed(decimals);
}

/**
 * Divide the totals of every deellading group in place. Groups are formed by
 * the shared reference base among orders tagged "deellading"; only groups of
 * 2+ are divided. Returns the number of groups divided (for logging).
 */
export function applyDeelladingDivision(orders: SplitOrder[]): number {
  const groups = new Map<string, SplitOrder[]>();
  for (const order of orders ?? []) {
    if (!order?.fields || !isDeellading(order.fields)) continue;
    const base = deelladingBaseRef(order.externalReference);
    if (!base) continue;
    const list = groups.get(base) ?? [];
    list.push(order);
    groups.set(base, list);
  }

  let dividedGroups = 0;
  for (const group of groups.values()) {
    const count = group.length;
    if (count < 2) continue;
    dividedGroups++;
    for (const order of group) {
      for (const key of WEIGHT_KEYS) divideMeasure(order.fields, key, count, 0);
      for (const key of VOLUME_KEYS) divideMeasure(order.fields, key, count, 2);
    }
  }
  return dividedGroups;
}
