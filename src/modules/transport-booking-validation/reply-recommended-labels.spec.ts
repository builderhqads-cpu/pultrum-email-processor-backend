import {
  ALIAS_FALLBACK_INDEX,
  extractLabeledFields,
  normalizeLabel,
} from './transport-booking-validation.service';

/**
 * Regression test for the customer-reply case where pickup_date_till,
 * pickup_time_till, delivery_time_till and product_description were supplied
 * in the reply but dropped because the curated labelToKeys map had no entry
 * for them.
 *
 * It proves the two halves of the lookup line up:
 *   labelToKeys[ extractLabeledFields(reply) -> label ] -> the right key
 */
describe('customer reply — recommended labels', () => {
  const reply = [
    'Good morning,',
    'Thank you for your email.',
    'Please find below the requested information:',
    'Pickup country: Denmark (DK)',
    'Pickup zipcode: 6330',
    'Pickup city: Padborg',
    'Invoice reference: 1234567890',
    '',
    'Additionally, here is the extra information that may be useful:',
    'Pickup date till: 2026-07-02',
    'Pickup time: 10:00',
    'Pickup time till: 10:30',
    'Pickup contact: John Hansen',
    'Pickup phone: +4512345678',
    'Delivery time till: 12:30',
    'Delivery contact: Maria Schmidt',
    'Delivery phone: +4912345678',
    'Product description: Product 1109',
    'Pallet places: 1',
    'Transport type: Standard',
    'Fixed price: EUR 250',
    'Reference: [PULTRUM- 358d3ab8 ]',
  ].join('\n');

  const extracted = extractLabeledFields(reply);

  it('extracts the previously-dropped labels with correct values', () => {
    expect(extracted.get(normalizeLabel('Pickup date till'))).toBe('2026-07-02');
    expect(extracted.get(normalizeLabel('Pickup time till'))).toBe('10:30');
    expect(extracted.get(normalizeLabel('Delivery time till'))).toBe('12:30');
    expect(extracted.get(normalizeLabel('Product description'))).toBe(
      'Product 1109',
    );
  });

  it('still extracts the base time fields without being shadowed', () => {
    expect(extracted.get(normalizeLabel('Pickup time'))).toBe('10:00');
  });

  it('normalized labels match the keys added to labelToKeys', () => {
    // These must equal exactly the normalizeLabel(...) keys added to the map.
    expect(normalizeLabel('Pickup date till')).toBe('pickup date till');
    expect(normalizeLabel('Pickup time till')).toBe('pickup time till');
    expect(normalizeLabel('Delivery time till')).toBe('delivery time till');
    expect(normalizeLabel('Product description')).toBe('product description');
  });
});

describe('catalog alias fallback index', () => {
  it('maps catalog labels that are absent from the curated map', () => {
    expect(ALIAS_FALLBACK_INDEX.get('pallet places')).toContain('pallet_places');
    expect(ALIAS_FALLBACK_INDEX.get('dangerous goods')).toContain(
      'dangerous_goods',
    );
    expect(ALIAS_FALLBACK_INDEX.get('product description')).toContain(
      'product_description',
    );
  });

  it('excludes ambiguous / very short aliases to avoid mismapping', () => {
    // A bare "Reference:" line (e.g. the PULTRUM token) must NOT map.
    expect(ALIAS_FALLBACK_INDEX.has('reference')).toBe(false);
    expect(ALIAS_FALLBACK_INDEX.has('ref')).toBe(false);
    expect(ALIAS_FALLBACK_INDEX.has('till')).toBe(false);
    expect(ALIAS_FALLBACK_INDEX.has('price')).toBe(false);
    expect(ALIAS_FALLBACK_INDEX.has('kg')).toBe(false);
  });
});
