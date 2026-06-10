import {
  extractLabeledFields,
  normalizeLabel,
} from './transport-booking-validation.service';

describe('extractLabeledFields', () => {
  const emailText = `
Laaddatum: 2026-06-01
Laadtijd: 10:00
Laadreferentie: 123456
Laadnaam: E3 Spedition-Transport A/S
Laadadres: Transitvej 16
Laadland: DK
Laadpostcode: 6330
Laadplaats: Padborg
Laad contact: John
Laad telefoonnummer: +4512345678
Laad e-mailadres: pickup@example.com

Losdatum: 2026-06-02
Lostijd: 12:00
Losreferentie: 789178
Losnaam: Systro Gastronomie GmbH
Losadres: Rodgaustraße 7
Losland: DE
Lospostcode: 63457
Losplaats: Hanau
Los contact: Maria
Los telefoonnummer: +4912345678
Los e-mailadres: delivery@example.com

Aantal: 5
Eenheid: colli
Product: 1109
Gewicht: 50
Lengte: 20
Breedte: 20
Hoogte: 90
Transportsoort: standaard
Factuurreferentie: 1234567890
Prijs: 250
`.trim();

  it('extracts exact labels with diacritics normalization', () => {
    const extracted = extractLabeledFields(emailText);

    expect(extracted.get(normalizeLabel('Laaddatum'))).toBe('2026-06-01');
    expect(extracted.get(normalizeLabel('Laadtijd'))).toBe('10:00');
    expect(extracted.get(normalizeLabel('Laadreferentie'))).toBe('123456');
    expect(extracted.get(normalizeLabel('Laadnaam'))).toBe(
      'E3 Spedition-Transport A/S',
    );
    expect(extracted.get(normalizeLabel('Laadadres'))).toBe('Transitvej 16');
    expect(extracted.get(normalizeLabel('Laadland'))).toBe('DK');
    expect(extracted.get(normalizeLabel('Laadpostcode'))).toBe('6330');
    expect(extracted.get(normalizeLabel('Laadplaats'))).toBe('Padborg');
    expect(extracted.get(normalizeLabel('Laad contact'))).toBe('John');
    expect(extracted.get(normalizeLabel('Laad telefoonnummer'))).toBe(
      '+4512345678',
    );
    expect(extracted.get(normalizeLabel('Laad e-mailadres'))).toBe(
      'pickup@example.com',
    );

    expect(extracted.get(normalizeLabel('Losdatum'))).toBe('2026-06-02');
    expect(extracted.get(normalizeLabel('Lostijd'))).toBe('12:00');
    expect(extracted.get(normalizeLabel('Losreferentie'))).toBe('789178');
    expect(extracted.get(normalizeLabel('Losnaam'))).toBe(
      'Systro Gastronomie GmbH',
    );
    expect(extracted.get(normalizeLabel('Losadres'))).toBe('Rodgaustraße 7');
    expect(extracted.get(normalizeLabel('Losland'))).toBe('DE');
    expect(extracted.get(normalizeLabel('Lospostcode'))).toBe('63457');
    expect(extracted.get(normalizeLabel('Losplaats'))).toBe('Hanau');
    expect(extracted.get(normalizeLabel('Los contact'))).toBe('Maria');
    expect(extracted.get(normalizeLabel('Los telefoonnummer'))).toBe(
      '+4912345678',
    );
    expect(extracted.get(normalizeLabel('Los e-mailadres'))).toBe(
      'delivery@example.com',
    );

    expect(extracted.get(normalizeLabel('Aantal'))).toBe('5');
    expect(extracted.get(normalizeLabel('Eenheid'))).toBe('colli');
    expect(extracted.get(normalizeLabel('Product'))).toBe('1109');
    expect(extracted.get(normalizeLabel('Gewicht'))).toBe('50');
    expect(extracted.get(normalizeLabel('Lengte'))).toBe('20');
    expect(extracted.get(normalizeLabel('Breedte'))).toBe('20');
    expect(extracted.get(normalizeLabel('Hoogte'))).toBe('90');
    expect(extracted.get(normalizeLabel('Transportsoort'))).toBe('standaard');
    expect(extracted.get(normalizeLabel('Factuurreferentie'))).toBe(
      '1234567890',
    );
    expect(extracted.get(normalizeLabel('Prijs'))).toBe('250');
  });

  it('extracts reply variants like afleveradres fields', () => {
    const reply = `
Postcode afleveradres: 63457
Land afleveradres: Duitsland (DE)
`.trim();

    const extracted = extractLabeledFields(reply);
    expect(extracted.get(normalizeLabel('Postcode afleveradres'))).toBe(
      '63457',
    );
    expect(extracted.get(normalizeLabel('Land afleveradres'))).toBe(
      'Duitsland (DE)',
    );
  });

  it('extracts reply fields when the value comes on the next lines', () => {
    const reply = `
Hello,

Please find the requested information below:

Pickup time: 10:00

Pickup contact:
John Hansen

Pickup phone:
+4512345678

Pickup email:
[pickup@example.com](mailto:pickup@example.com)

Delivery contact:
Maria Schmidt

Delivery phone:
+4912345678

Delivery email:
[delivery@example.com](mailto:delivery@example.com)

Kind regards,

Renato Cardoso
`.trim();

    const extracted = extractLabeledFields(reply);
    expect(extracted.get(normalizeLabel('Pickup time'))).toBe('10:00');
    expect(extracted.get(normalizeLabel('Pickup contact'))).toBe('John Hansen');
    expect(extracted.get(normalizeLabel('Pickup phone'))).toBe('+4512345678');
    expect(extracted.get(normalizeLabel('Pickup email'))).toBe(
      'pickup@example.com',
    );
    expect(extracted.get(normalizeLabel('Delivery contact'))).toBe(
      'Maria Schmidt',
    );
    expect(extracted.get(normalizeLabel('Delivery phone'))).toBe('+4912345678');
    expect(extracted.get(normalizeLabel('Delivery email'))).toBe(
      'delivery@example.com',
    );
  });

  it('extracts reply fields when values come inline with mailto wrappers', () => {
    const reply = `
Hello,
Please find the requested information below:
Pickup time: 10:00
Pickup contact: John Hansen
Pickup phone: +4512345678
Pickup email: pickup@example.com<mailto:pickup@example.com>
Delivery contact: Maria Schmidt
Delivery phone: +4912345678
Delivery email: delivery@example.com<mailto:delivery@example.com>
Kind regards,
Renato Cardoso
`.trim();

    const extracted = extractLabeledFields(reply);
    expect(extracted.get(normalizeLabel('Pickup email'))).toBe(
      'pickup@example.com',
    );
    expect(extracted.get(normalizeLabel('Delivery email'))).toBe(
      'delivery@example.com',
    );
  });

  it('extracts cargo fields from english multiline reply labels', () => {
    const reply = `
Cargo Information
Product:
1109
Length:
20 cm
Width:
20 cm
Height:
90 cm
`.trim();

    const extracted = extractLabeledFields(reply);
    expect(extracted.get(normalizeLabel('Product'))).toBe('1109');
    expect(extracted.get(normalizeLabel('Length'))).toBe('20 cm');
    expect(extracted.get(normalizeLabel('Width'))).toBe('20 cm');
    expect(extracted.get(normalizeLabel('Height'))).toBe('90 cm');
  });
});
