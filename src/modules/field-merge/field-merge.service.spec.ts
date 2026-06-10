import { FieldMergeService, type MergeableField } from './field-merge.service';

describe('FieldMergeService', () => {
  it('keeps the highest confidence per key', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'pickup_date',
        value: '2026-06-01',
        confidence: 0.95,
        source: 'EMAIL',
      },
      {
        key: 'pickup_date',
        value: '2026-06-02',
        confidence: 0.8,
        source: 'REGEX',
      },
    ];

    const res = service.merge(input);
    const merged = res.find((f) => f.key === 'pickup_date')!;
    expect(merged.value).toBe('2026-06-01');
    expect(merged.confidence).toBe(0.95);
    expect(merged.source).toBe('EMAIL');
  });

  it('does not overwrite EMAIL by AI with lower confidence', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'invoice_reference',
        value: '123',
        confidence: 0.95,
        source: 'EMAIL',
      },
      { key: 'invoice_reference', value: '999', confidence: 0.8, source: 'AI' },
    ];

    const res = service.merge(input);
    const merged = res.find((f) => f.key === 'invoice_reference')!;
    expect(merged.value).toBe('123');
    expect(merged.source).toBe('EMAIL');
  });

  it('overwrites when incoming has higher confidence (even AI)', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'pickup_city',
        value: 'Padborg',
        confidence: 0.8,
        source: 'EMAIL',
      },
      { key: 'pickup_city', value: 'Padborg', confidence: 0.9, source: 'AI' },
    ];

    const res = service.merge(input);
    const merged = res.find((f) => f.key === 'pickup_city')!;
    expect(merged.confidence).toBe(0.9);
    expect(merged.source).toBe('AI');
  });

  it('sanitizes HTML and converts empty to null (ignored)', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'invoice_reference',
        value: '1234567890<br>',
        confidence: 0.8,
        source: 'REGEX',
      },
      {
        key: 'pickup_email',
        value: '   <div></div>   ',
        confidence: 0.95,
        source: 'EMAIL',
      },
    ];

    const res = service.merge(input);
    const invoice = res.find((f) => f.key === 'invoice_reference')!;
    expect(invoice.value).toBe('1234567890');

    expect(res.some((f) => f.key === 'pickup_email')).toBe(false);
  });

  it('uses source priority on confidence ties', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'edireference',
        value: 'EDI-1',
        confidence: 1,
        source: 'GENERATED',
      },
      { key: 'edireference', value: 'EDI-2', confidence: 1, source: 'AI' },
    ];

    const res = service.merge(input);
    const merged = res.find((f) => f.key === 'edireference')!;
    expect(merged.value).toBe('EDI-1');
    expect(merged.source).toBe('GENERATED');
  });

  it('prefers the latest value when confidence and source priority are tied', () => {
    const service = new FieldMergeService();

    const input: MergeableField[] = [
      {
        key: 'pickup_phone',
        value: '+4511111111',
        confidence: 0.95,
        source: 'EMAIL',
      },
      {
        key: 'pickup_phone',
        value: '+4522222222',
        confidence: 0.95,
        source: 'EMAIL',
      },
    ];

    const res = service.merge(input);
    const merged = res.find((f) => f.key === 'pickup_phone')!;
    expect(merged.value).toBe('+4522222222');
    expect(merged.source).toBe('EMAIL');
  });
});
