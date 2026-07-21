import { EmailProcessingProcessor } from './email-processing.processor';

/**
 * Customer-profile fields are registered facts: they must beat whatever the AI
 * read from the email. Inferred values (geocoded zipcodes) keep the opposite
 * rule — they only fill gaps. These two behaviours are easy to swap by accident
 * (both are "merges"), so they are pinned here.
 */
describe('EmailProcessingProcessor field precedence', () => {
  const processor = Object.create(
    EmailProcessingProcessor.prototype,
  ) as EmailProcessingProcessor;

  const applyProfileOverrides = (
    fields: Record<string, unknown>,
    profile: Record<string, string>,
  ) => (processor as any).applyProfileOverrides(fields, profile);

  const mergeMissingFieldValues = (
    fields: Record<string, unknown>,
    detected: Array<{ key: string; value: string }>,
  ) => (processor as any).mergeMissingFieldValues(fields, detected);

  it('lets the registered profile value override what the AI extracted', () => {
    const merged = applyProfileOverrides(
      { pickup_time: '22:00', delivery_city: 'Koln' },
      { pickup_time: '08:00' },
    );

    expect(merged.pickup_time).toBe('08:00');
    // Fields the profile says nothing about are untouched.
    expect(merged.delivery_city).toBe('Koln');
  });

  it('fills fields the AI left empty', () => {
    const merged = applyProfileOverrides(
      { pickup_contact: '' },
      { pickup_contact: 'Renato', pickup_phone: '+31 6 1234 5678' },
    );

    expect(merged.pickup_contact).toBe('Renato');
    expect(merged.pickup_phone).toBe('+31 6 1234 5678');
  });

  it('never blanks a value with an empty profile entry', () => {
    const merged = applyProfileOverrides(
      { pickup_time: '22:00' },
      { pickup_time: '   ' },
    );

    expect(merged.pickup_time).toBe('22:00');
  });

  it('keeps inferred values (geocoding) as gap-fillers only', () => {
    const merged = mergeMissingFieldValues({ delivery_zipcode: '1703 TX' }, [
      { key: 'delivery_zipcode', value: '9999 ZZ' },
      { key: 'pickup_zipcode', value: '41372' },
    ]);

    // What is already there wins over an inference...
    expect(merged.delivery_zipcode).toBe('1703 TX');
    // ...but a missing one is filled.
    expect(merged.pickup_zipcode).toBe('41372');
  });
});
