import { ClientProfileService } from '../client-profiles/client-profile.service';
import { OrderSplitService } from './order-split.service';

// AI fallback stub — disabled by default so tests stay deterministic.
const aiOff = { enabled: () => false, split: async () => null } as any;

const DISPO =
  '26TR001406 LZV 186 26BA005572 P. Pultrum Rijssen BV Offener Sattel 14.536 19.06.2026 12:00\n' +
  '1 LT01 22.06.2026 08:00 RAAB Baugesellschaft DE 96257 Redwitz\n' +
  '26TR001405 LZV 407 26BA005574 P. Pultrum Rijssen BV Tele-Sattel 9.387 19.06.2026 14:00\n' +
  '1 LT04 22.06.2026 08:00 Hamdorf Holzbau DE 24966 Soerup\n' +
  '25TR003032 402 26BA005575 P. Pultrum Rijssen BV Offener Sattel 7.365 19.06.2026 14:01\n' +
  '1 LT01 22.06.2026 08:01 Baustoffe Vogt DE 48163 Muenster ' +
  '2 LT25 22.06.2026 10:01 Brueninghoff Holz DE 46359 Heiden\n';

describe('OrderSplitService', () => {
  const profiles = new ClientProfileService({ get: () => 'true' } as any);
  const service = new OrderSplitService(profiles, aiOff);

  it('splits a Derix Dispo into one order per TR block (load+delivery kept together)', async () => {
    const result = await service.split({
      fromEmail: 'transporte.wk@derix.de',
      combinedText: DISPO,
    });

    expect(result.isBatch).toBe(true);
    expect(result.source).toBe('derix-tr-lt');
    expect(result.orders).toHaveLength(3); // one per TR block
    expect(result.orders.map((o) => o.externalReference)).toEqual([
      '26TR001406-LT01',
      '26TR001405-LT04',
      '25TR003032-LT01',
    ]);
    // The TR block with two LT rows stays a single order (no data loss).
    expect(result.orders[2].rawText).toContain('Muenster');
    expect(result.orders[2].rawText).toContain('Heiden');
  });

  it('applies the Derix profile to each chunk (fixed data, references, transportsoort)', async () => {
    const result = await service.split({
      fromEmail: 'transporte.wk@derix.de',
      combinedText: DISPO,
    });
    const first = result.orders[0];
    expect(first.derivedFields.pickup_city).toBe('Westerkappeln');
    expect(first.derivedFields.pickup_country).toBe('DE');
    expect(first.invoiceReference).toBe('26BA005572');
    expect(first.derivedFields.invoice_reference).toBe('26BA005572');
    expect(first.derivedFields.pickup_reference).toBe('26TR001406 LT01');
    expect(first.derivedFields.transport_type).toBe('Platte X-Lam');
    // Tele-Sattel maps differently on the second order.
    expect(result.orders[1].derivedFields.transport_type).toBe(
      'Schuif trailer',
    );
  });

  it('returns single for an unmapped client when AI fallback is off', async () => {
    const result = await service.split({
      fromEmail: 'someone@example.com',
      combinedText: 'Just one order, please pick up tomorrow.',
    });
    expect(result.isBatch).toBe(false);
    expect(result.source).toBe('single');
  });

  it('uses our own AI fallback for an unmapped client when enabled', async () => {
    const aiOn = {
      enabled: () => true,
      split: async () => ({
        isBatch: true,
        confidence: 0.9,
        reason: 'two orders',
        orders: [
          { externalReference: 'A1', invoiceReference: null, rawText: 'order 1' },
          { externalReference: 'A2', invoiceReference: null, rawText: 'order 2' },
        ],
      }),
    } as any;
    const svc = new OrderSplitService(profiles, aiOn);

    const result = await svc.split({
      fromEmail: 'someone@example.com',
      combinedText: 'order 1 ... order 2 ...',
    });
    expect(result.isBatch).toBe(true);
    expect(result.source).toBe('heuristic');
    expect(result.orders).toHaveLength(2);
  });
});
