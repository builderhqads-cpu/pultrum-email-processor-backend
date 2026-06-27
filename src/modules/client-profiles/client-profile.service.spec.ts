import { ClientProfileService } from './client-profile.service';

describe('ClientProfileService', () => {
  // Engine enabled for these tests (production default is OFF).
  const service = new ClientProfileService({ get: () => 'true' } as any);

  it('resolves Derix by the sender domain', () => {
    const p = service.resolve({ fromEmail: 'transporte.wk@derix.de' });
    expect(p?.id).toBe('derix-wk');
  });

  it('resolves Derix by a specific matched address', () => {
    const p = service.resolve({ fromEmail: 'n.mindrup@derix.de' });
    expect(p?.id).toBe('derix-wk');
  });

  it('resolves a forwarded Derix order from the body (forwarder is Pultrum)', () => {
    const p = service.resolve({
      fromEmail: 'nsterken@pultrum-rijssen.nl',
      bodyText:
        'Von: Nils Mindrup <transporte.wk@derix.de>\nGesendet: ...\nDispo KW26',
    });
    expect(p?.id).toBe('derix-wk');
  });

  it('returns null for an unknown sender', () => {
    const p = service.resolve({
      fromEmail: 'someone@example.com',
      bodyText: 'no client address here',
    });
    expect(p).toBeNull();
  });

  it('recognizes Derix by document content (forwarded / test send)', () => {
    // Sent from a non-Derix address, but the Dispoliste content is unmistakable.
    const p = service.resolve({
      fromEmail: 'renatoscardoso77@gmail.com',
      text: 'Dispoliste KW25\n26TR001374 26BA005384 Offener Sattel 6.591,600 kg',
    });
    expect(p?.id).toBe('derix-wk');
  });

  it('does not misidentify another client with a different reference format', () => {
    const p = service.resolve({
      fromEmail: 'planning@othercarrier.com',
      text: 'Factuur referentie 8031 DX\nLevering morgen 14:00',
    });
    expect(p).toBeNull();
  });

  it('Derix profile carries the fixed loading data and split rule', () => {
    const p = service.byId('derix-wk');
    expect(p?.fixedFields?.pickup_city).toBe('Westerkappeln');
    expect(p?.fixedFields?.pickup_country).toBe('DE');
    expect(p?.split).toEqual({ mode: 'deterministic', strategy: 'derix-tr-lt' });
    expect(p?.valueMaps?.transport_type?.['Offener Sattel']).toBe('Platte X-Lam');
  });

  it('derives deterministic fields from one order block', () => {
    const derix = service.byId('derix-wk')!;
    const orderText =
      '26TR001406 LZV 186 26BA005572 P. Pultrum Rijssen BV Offener Sattel ' +
      '14.536 X-LAM 19.06.2026 12:00 RAAB Baugesellschaft DE 96257 Redwitz';

    const fields = service.derive(derix, orderText);

    // Fixed loading data.
    expect(fields.pickup_city).toBe('Westerkappeln');
    expect(fields.pickup_country).toBe('DE');
    // Reference patterns.
    expect(fields.invoice_reference).toBe('26BA005572');
    expect(fields.pickup_reference).toBe('26TR001406');
    // Transportsoort value map.
    expect(fields.transport_type).toBe('Platte X-Lam');
  });
});
