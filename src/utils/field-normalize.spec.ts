import {
  blankIfZero,
  dropNameIfCity,
  normalizeFieldMap,
  normalizeQuantity,
  parseDecimal,
  splitStreetAddress,
  toCentimeters,
} from './field-normalize';

describe('field-normalize', () => {
  describe('parseDecimal (German/EU notation)', () => {
    it('parses German notation (dot=thousands, comma=decimal)', () => {
      expect(parseDecimal('14.536,350')).toBeCloseTo(14536.35, 2);
      expect(parseDecimal('33,883')).toBeCloseTo(33.883, 3);
      expect(parseDecimal('1.234.567')).toBe(1234567);
      expect(parseDecimal('12,5')).toBe(12.5);
    });

    it('parses English notation (comma=thousands, dot=decimal)', () => {
      expect(parseDecimal('1,234.56')).toBeCloseTo(1234.56, 2);
      expect(parseDecimal('1.5')).toBe(1.5);
    });

    it('handles plain integers, units and non-numeric', () => {
      expect(parseDecimal('14.536,350 kg')).toBeCloseTo(14536.35, 2);
      expect(parseDecimal('120')).toBe(120);
      expect(parseDecimal('14.536')).toBe(14536); // single dot, 3 digits => thousands
      expect(parseDecimal('0.750')).toBe(0.75); // leading zero => decimal
      expect(parseDecimal('')).toBeNull();
      expect(parseDecimal('n/a')).toBeNull();
    });
  });

  describe('toCentimeters', () => {
    it('converts mm and m to cm when a unit is present', () => {
      expect(toCentimeters('1200 mm')).toBe('120');
      expect(toCentimeters('1,2 m')).toBe('120');
      expect(toCentimeters('120 cm')).toBe('120');
      expect(toCentimeters('1255 mm')).toBe('125.5');
    });

    it('leaves a unitless number unscaled (just cleans notation)', () => {
      expect(toCentimeters('120')).toBe('120');
      expect(toCentimeters('')).toBe('');
    });
  });

  describe('normalizeQuantity', () => {
    it('strips decimals to a whole integer', () => {
      expect(normalizeQuantity('1,00')).toBe('1');
      expect(normalizeQuantity('2.0')).toBe('2');
      expect(normalizeQuantity('1,00 st')).toBe('1');
      expect(normalizeQuantity('3')).toBe('3');
    });

    it('returns blank for empty and keeps non-numeric untouched', () => {
      expect(normalizeQuantity('')).toBe('');
      expect(normalizeQuantity(null)).toBe('');
      expect(normalizeQuantity('pallets')).toBe('pallets');
    });
  });

  describe('blankIfZero', () => {
    it('blanks zero and empty values', () => {
      expect(blankIfZero('0')).toBe('');
      expect(blankIfZero('0,00')).toBe('');
      expect(blankIfZero('0.000')).toBe('');
      expect(blankIfZero('')).toBe('');
      expect(blankIfZero(null)).toBe('');
    });

    it('returns a clean number for real values (fixes notation, drops units)', () => {
      expect(blankIfZero('12,5')).toBe('12.5');
      expect(blankIfZero('1200 kg')).toBe('1200');
      expect(blankIfZero('14.536,350 kg')).toBe('14536.35');
    });
  });

  describe('dropNameIfCity', () => {
    it('blanks a name that just echoes the city', () => {
      expect(dropNameIfCity('Best', 'Best')).toBe('');
      expect(dropNameIfCity('best', 'Best')).toBe('');
    });

    it('keeps a real name and tolerates empty city', () => {
      expect(dropNameIfCity('vd Klok Bouw', 'Best')).toBe('vd Klok Bouw');
      expect(dropNameIfCity('vd Klok Bouw', '')).toBe('vd Klok Bouw');
      expect(dropNameIfCity('', 'Best')).toBe('');
    });
  });

  describe('splitStreetAddress', () => {
    it('pulls a NL postcode + city out of a concatenated address', () => {
      expect(
        splitStreetAddress({
          address: 'Grasbeemd 30 5682 JT Best',
          zipcode: '',
          city: '',
        }),
      ).toEqual({ address: 'Grasbeemd 30', zipcode: '5682 JT', city: 'Best' });
    });

    it('does not touch the address when zipcode already exists', () => {
      expect(
        splitStreetAddress({
          address: 'Boostraat 8',
          zipcode: '7461 AK',
          city: 'Rijssen',
        }),
      ).toEqual({ address: 'Boostraat 8', zipcode: '7461 AK', city: 'Rijssen' });
    });

    it('keeps an existing city and only fills the zipcode', () => {
      expect(
        splitStreetAddress({
          address: 'Nijverheidsstraat 15 7461 AK',
          zipcode: '',
          city: 'Rijssen',
        }),
      ).toEqual({
        address: 'Nijverheidsstraat 15',
        zipcode: '7461 AK',
        city: 'Rijssen',
      });
    });

    it('leaves a plain street with no postcode unchanged', () => {
      expect(
        splitStreetAddress({ address: 'Boostraat 8', zipcode: '', city: '' }),
      ).toEqual({ address: 'Boostraat 8', zipcode: '', city: '' });
    });
  });

  describe('normalizeFieldMap', () => {
    it('applies all rules in place', () => {
      const map = new Map<string, string>([
        ['cargo_unit_amount', '1,00'],
        ['cargo_loading_meter', '0'],
        ['cargo_volume', '0,000'],
        ['cargo_weight', '14.536,350 kg'],
        ['length', '1200 mm'],
        ['delivery_name', 'Best'],
        ['delivery_city', 'Best'],
        ['delivery_address', 'Grasbeemd 30 5682 JT Best'],
        ['delivery_zipcode', ''],
      ]);

      normalizeFieldMap(map);

      expect(map.get('cargo_unit_amount')).toBe('1');
      expect(map.get('cargo_loading_meter')).toBe('');
      expect(map.get('cargo_volume')).toBe('');
      expect(map.get('cargo_weight')).toBe('14536.35');
      expect(map.get('length')).toBe('120');
      expect(map.get('delivery_name')).toBe('');
      expect(map.get('delivery_address')).toBe('Grasbeemd 30');
      expect(map.get('delivery_zipcode')).toBe('5682 JT');
      expect(map.get('delivery_city')).toBe('Best');
    });
  });
});
