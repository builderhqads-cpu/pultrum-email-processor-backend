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

  // --- Niek #8: match a whole DOMAIN in the extra emails ---

  it('resolves a DB profile by the sender domain (bare-domain entry)', () => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    (svc as any).databaseProfiles = [
      { id: 'acme', name: 'ACME', match: { emails: [], domains: ['acme-co.com'] }, fixedFields: {} },
    ];
    expect(svc.resolve({ fromEmail: 'anyone@acme-co.com' })?.id).toBe('acme');
    expect(svc.resolve({ fromEmail: 'boss@acme-co.com' })?.id).toBe('acme');
    expect(svc.resolve({ fromEmail: 'someone@other.com' })).toBeNull();
  });

  it('a domain matches ONLY the direct sender, never a random body address', () => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    (svc as any).databaseProfiles = [
      { id: 'acme', name: 'ACME', match: { emails: [], domains: ['acme-co.com'] }, fixedFields: {} },
    ];
    // sender is a different domain; body mentions an acme-co.com address
    const p = svc.resolve({
      fromEmail: 'someone@else.com',
      bodyText: 'you can reach us at info@acme-co.com',
    });
    expect(p).toBeNull();
  });

  it('a profile without a domain entry does NOT match the whole domain (unchanged)', () => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    (svc as any).databaseProfiles = [
      { id: 'acme', name: 'ACME', match: { emails: ['orders@acme-co.com'], domains: [] }, fixedFields: {} },
    ];
    expect(svc.resolve({ fromEmail: 'orders@acme-co.com' })?.id).toBe('acme');
    expect(svc.resolve({ fromEmail: 'other@acme-co.com' })).toBeNull();
  });

  it('accepts a bare domain in additional emails and stores it as @domain', () => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    const out = (svc as any).normalizeAdditionalContactEmails(
      ['derix.de', '@acme-co.com', 'user@derix.de'],
      'primary@x.com',
    );
    expect(out).toContain('@derix.de');
    expect(out).toContain('@acme-co.com');
    expect(out).toContain('user@derix.de');
  });

  it('still rejects a truly invalid additional entry', () => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    expect(() =>
      (svc as any).normalizeAdditionalContactEmails(['invalidentry'], 'p@x.com'),
    ).toThrow();
  });

  // --- #3 (Van Losser): resolve the client per order by opdrachtgever ---

  const withProfiles = (profiles: any[]) => {
    const svc = new ClientProfileService({ get: () => 'false' } as any);
    (svc as any).databaseProfiles = profiles;
    return svc;
  };

  it('resolves the client from the opdrachtgever, normalized (case, B.V., spaces, accents)', () => {
    const svc = withProfiles([
      { id: 'etb', name: 'ETB Dijkink B.V.', match: { emails: [], domains: [] }, fixedFields: { customer_id: '111' } },
      { id: 'bowa', name: 'Bowa Installaties Emmen B.V.', match: { emails: [], domains: [] }, fixedFields: { customer_id: '222' } },
    ]);
    expect(svc.resolveByOpdrachtgever('ETB DIJKINK BV')?.id).toBe('etb');
    expect(svc.resolveByOpdrachtgever('  etb   dijkink  b.v. ')?.id).toBe('etb');
    expect(svc.resolveByOpdrachtgever('Bowa Installaties Emmen BV')?.id).toBe('bowa');
  });

  it('returns null when the opdrachtgever is missing or unknown (never guesses)', () => {
    const svc = withProfiles([
      { id: 'etb', name: 'ETB Dijkink B.V.', match: { emails: [], domains: [] }, fixedFields: {} },
    ]);
    expect(svc.resolveByOpdrachtgever(null)).toBeNull();
    expect(svc.resolveByOpdrachtgever('   ')).toBeNull();
    expect(svc.resolveByOpdrachtgever('Some Other Company')).toBeNull();
  });

  it('returns null when the opdrachtgever is ambiguous (matches >1 profile)', () => {
    const svc = withProfiles([
      { id: 'a', name: 'ACME B.V.', match: { emails: [], domains: [] }, fixedFields: {} },
      { id: 'b', name: 'ACME BV', match: { emails: [], domains: [] }, fixedFields: {} },
    ]);
    // Both normalize to "ACME BV" -> ambiguous -> unresolved (never a wrong customer_id).
    expect(svc.resolveByOpdrachtgever('ACME B.V.')).toBeNull();
  });
});
