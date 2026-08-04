import { isExcludedParty, parseExcludedPartyNames } from './order-exclusion';

describe('order-exclusion', () => {
  describe('parseExcludedPartyNames', () => {
    it('defaults to withagen when unset or empty', () => {
      expect(parseExcludedPartyNames(undefined)).toEqual(['withagen']);
      expect(parseExcludedPartyNames('')).toEqual(['withagen']);
      expect(parseExcludedPartyNames(null)).toEqual(['withagen']);
    });

    it('parses a comma-separated, trimmed, lowercased list', () => {
      expect(parseExcludedPartyNames('Withagen, Foo Bv')).toEqual([
        'withagen',
        'foo bv',
      ]);
    });
  });

  describe('isExcludedParty', () => {
    const excluded = parseExcludedPartyNames(undefined);

    it('drops an order delivered to Withagen (real case 25TR003230)', () => {
      expect(
        isExcludedParty(
          { delivery_name: 'Withagen Houtprodukten' },
          excluded,
        ),
      ).toBe(true);
    });

    it('matches case-insensitively and on pickup_name too', () => {
      expect(isExcludedParty({ delivery_name: 'WITHAGEN' }, excluded)).toBe(
        true,
      );
      expect(isExcludedParty({ pickup_name: 'withagen bv' }, excluded)).toBe(
        true,
      );
    });

    it('keeps a normal order', () => {
      expect(
        isExcludedParty({ delivery_name: 'Meurer Roofland A.G.' }, excluded),
      ).toBe(false);
    });

    it('handles missing fields and an empty exclusion list', () => {
      expect(isExcludedParty(null, excluded)).toBe(false);
      expect(isExcludedParty({}, excluded)).toBe(false);
      expect(isExcludedParty({ delivery_name: 'Withagen' }, [])).toBe(false);
    });
  });
});
