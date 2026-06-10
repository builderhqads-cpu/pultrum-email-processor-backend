import { LabelParserService } from './label-parser.service';

describe('LabelParserService', () => {
  it('extracts fields using exact label aliases', () => {
    const service = new LabelParserService();

    const text = `
Laaddatum: 2026-06-01
Laadadres: Transitvej 16
Losdatum: 2026-06-02
Aantal: 5
`.trim();

    const res = service.extract(text);
    const byKey = new Map(res.map((r) => [r.key, r.value]));

    expect(byKey.get('pickup_date')).toBe('2026-06-01');
    expect(byKey.get('pickup_address')).toBe('Transitvej 16');
    expect(byKey.get('delivery_date')).toBe('2026-06-02');
    expect(byKey.get('unit_amount')).toBe('5');
  });

  it('supports dash separator with surrounding spaces', () => {
    const service = new LabelParserService();

    const text = `
Laadtijd - 10:00
`.trim();

    const res = service.extract(text);
    expect(res.some((r) => r.key === 'pickup_time' && r.value === '10:00')).toBe(
      true,
    );
  });
});

