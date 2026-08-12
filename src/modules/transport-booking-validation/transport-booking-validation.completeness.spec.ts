import { TransportBookingValidationService } from './transport-booking-validation.service';

// Locks Niek's "Volledigheid" formula: required fields fill the 0–70% band,
// and only once ALL required are present does the score cross 70% and the
// recommended fields fill the last 30%.
describe('TransportBookingValidationService.computeCompleteness', () => {
  const service = new TransportBookingValidationService(
    {} as any,
    { get: () => undefined } as any, // customer_id stays OPTIONAL
    { add: jest.fn() } as any,
    { add: jest.fn() } as any,
    {} as any,
  );

  const complete = (reqMissing: number, recMissing: number) =>
    service.computeCompleteness(reqMissing, recMissing);

  it('is 100% when nothing is missing', () => {
    expect(complete(0, 0)).toBe(100);
  });

  it('is exactly 70% when all required are present but no recommended', () => {
    // A huge recommended-missing count clamps recommended-done to 0.
    expect(complete(0, 999)).toBe(70);
  });

  it('stays within (70, 100] as recommended fields fill in', () => {
    const partial = complete(0, 1);
    expect(partial).toBeGreaterThan(70);
    expect(partial).toBeLessThanOrEqual(100);
  });

  it('drops below 70% as soon as a required field is missing', () => {
    const oneMissing = complete(1, 0);
    expect(oneMissing).toBeGreaterThan(0);
    expect(oneMissing).toBeLessThan(70);
  });

  it('is 0% when all required are missing — even with every recommended present', () => {
    // Gating: recommended must not lift the score while required is incomplete.
    expect(complete(999, 0)).toBe(0);
  });
});
