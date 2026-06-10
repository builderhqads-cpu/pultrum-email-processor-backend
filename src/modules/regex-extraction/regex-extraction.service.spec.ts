import { RegexExtractionService } from './regex-extraction.service';

describe('RegexExtractionService', () => {
  it('extracts fields from unstructured email text and normalizes values', () => {
    const service = new RegexExtractionService();

    const text = `
Good morning,
I would like to request transportation for a shipment that needs to be collected on 01/06/2026 from E3 Spedition-Transport A/S, located at Transitvej 16, Padborg, Denmark (ZIP code 6330).
The delivery should take place on 02/06/2026 at 12:00 PM to Systro Gastronomie GmbH, Rodgaustraße 7, 63457 Hanau, Germany.
The shipment consists of 5 colli of product 1109 with a total weight of 50 kg. The dimensions of each package are 20 x 20 x 90 cm.
References:
Pickup Reference: REF123
Delivery Reference: LOS789
Invoice Reference: 1234567890
`.trim();

    const res = service.extract(text);
    const byKey = new Map(res.map((r) => [r.key, r.value]));

    expect(byKey.get('pickup_date')).toBe('2026-06-01');
    expect(byKey.get('pickup_name')).toBe('E3 Spedition-Transport A/S');
    expect(byKey.get('pickup_address')).toBe('Transitvej 16');
    expect(byKey.get('pickup_city')).toBe('Padborg');
    expect(byKey.get('pickup_country')).toBe('DK');
    expect(byKey.get('pickup_zipcode')).toBe('6330');

    expect(byKey.get('delivery_date')).toBe('2026-06-02');
    expect(byKey.get('delivery_time')).toBe('12:00');
    expect(byKey.get('delivery_name')).toBe('Systro Gastronomie GmbH');
    expect(byKey.get('delivery_address')).toBe('Rodgaustraße 7');
    expect(byKey.get('delivery_zipcode')).toBe('63457');
    expect(byKey.get('delivery_city')).toBe('Hanau');
    expect(byKey.get('delivery_country')).toBe('DE');

    expect(byKey.get('cargo_unit_amount')).toBe('5');
    expect(byKey.get('cargo_unit_id')).toBe('colli');
    expect(byKey.get('product_id')).toBe('1109');
    expect(byKey.get('cargo_weight')).toBe('50');

    expect(byKey.get('length')).toBe('20');
    expect(byKey.get('width')).toBe('20');
    expect(byKey.get('height')).toBe('90');

    expect(byKey.get('pickup_reference')).toBe('REF123');
    expect(byKey.get('delivery_reference')).toBe('LOS789');
    expect(byKey.get('invoice_reference')).toBe('1234567890');

    for (const item of res) {
      expect(item.source).toBe('REGEX');
      expect(item.confidence).toBeGreaterThanOrEqual(0.75);
      expect(item.confidence).toBeLessThanOrEqual(0.85);
    }
  });

  it('does not override existing EMAIL fields with higher confidence', () => {
    const service = new RegexExtractionService();

    const text = `Delivery should take place on 02/06/2026 at 12:00 PM.`;

    const res = service.extract(text, [
      { key: 'delivery_time', value: '12:00', confidence: 0.95, source: 'EMAIL' },
    ]);

    expect(res.some((r) => r.key === 'delivery_time')).toBe(false);
  });
});

