import { applyDeelladingDivision, deelladingBaseRef } from './deellading';

describe('deellading', () => {
  describe('deelladingBaseRef', () => {
    it('strips a trailing split suffix', () => {
      expect(deelladingBaseRef('25TR003132-1')).toBe('25TR003132');
      expect(deelladingBaseRef('25TR003132-5')).toBe('25TR003132');
      expect(deelladingBaseRef('26TR000422_2')).toBe('26TR000422');
    });

    it('returns null when there is no suffix', () => {
      expect(deelladingBaseRef('26TR001450')).toBeNull();
      expect(deelladingBaseRef('')).toBeNull();
      expect(deelladingBaseRef(null)).toBeNull();
    });
  });

  describe('applyDeelladingDivision', () => {
    const deellading = (ref: string, weight: string, volume: string) => ({
      externalReference: ref,
      fields: {
        cargo_unit_id: 'deellading',
        cargo_weight: weight,
        cargo_volume: volume,
      } as Record<string, unknown>,
    });

    it('divides 25TR003132 (5 orders) — 2-decimal weight stays exact', () => {
      const orders = [1, 2, 3, 4, 5].map((n) =>
        deellading(`25TR003132-${n}`, '7.869,200', '17,134'),
      );
      const groups = applyDeelladingDivision(orders);
      expect(groups).toBe(1);
      for (const o of orders) {
        expect(o.fields.cargo_weight).toBe('1574'); // 7869.2/5 = 1573.84 -> 1574
        expect(o.fields.cargo_volume).toBe('3.43'); // 17.134/5 = 3.4268 -> 3.43
      }
    });

    it('divides 26TR000422 (2 orders) — the 3-decimal case that used to inflate', () => {
      const orders = [1, 2].map((n) =>
        deellading(`26TR000422-${n}`, '16.906,050', '37,569'),
      );
      applyDeelladingDivision(orders);
      for (const o of orders) {
        // Was showing 8453025 kg before; now the exact 8453.
        expect(o.fields.cargo_weight).toBe('8453'); // 16906.05/2 = 8453.025
        expect(o.fields.cargo_volume).toBe('18.78'); // 37.569/2 = 18.7845
      }
    });

    it('divides goods_* mirrors too when present', () => {
      const orders = [1, 2].map((n) => ({
        externalReference: `26TR001506-${n}`,
        fields: {
          cargo_unit_id: 'deellading',
          cargo_weight: '21.744,050',
          cargo_volume: '52,830',
          goods_weight: '21.744,050',
          goods_volume: '52,830',
        } as Record<string, unknown>,
      }));
      applyDeelladingDivision(orders);
      for (const o of orders) {
        expect(o.fields.cargo_weight).toBe('10872'); // 21744.05/2 = 10872.025
        expect(o.fields.goods_weight).toBe('10872');
        // 52.83/2 = 26.415, which is stored as 26.4149… in IEEE-754, so toFixed
        // rounds to 26.41 (deterministic; a 0.01 m3 edge either way is fine).
        expect(o.fields.cargo_volume).toBe('26.41');
        expect(o.fields.goods_volume).toBe('26.41');
      }
    });

    it('never touches vracht orders or lone deelladingen', () => {
      const orders = [
        {
          externalReference: '26TR001450',
          fields: {
            cargo_unit_id: 'vracht',
            cargo_weight: '12.389,400',
            cargo_volume: '27,532',
          } as Record<string, unknown>,
        },
        // a single deellading with a suffix but no sibling: not a group of 2+
        deellading('26TR009999-1', '10.000,000', '20,000'),
      ];
      const groups = applyDeelladingDivision(orders);
      expect(groups).toBe(0);
      expect(orders[0].fields.cargo_weight).toBe('12.389,400');
      expect(orders[1].fields.cargo_weight).toBe('10.000,000');
    });
  });
});
