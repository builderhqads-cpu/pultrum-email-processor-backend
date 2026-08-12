import type { ClientProfile } from '../client-profile.types';

/**
 * Derix Westerkappeln — first mapped client (source: Niek's "Derix WK" mapping).
 *
 * Derix is ALWAYS the loading location, so all pickup_* fields are constants.
 * Deliveries, references, transportsoort and the batch split follow fixed rules,
 * which makes this client almost fully deterministic (little to no AI needed).
 */
export const derixWesterkappelnProfile: ClientProfile = {
  id: 'derix-wk',
  name: 'Derix Westerkappeln',

  match: {
    domains: ['derix.de'],
    emails: ['transporte.wk@derix.de', 'n.mindrup@derix.de'],
    // Identify a Derix "Dispoliste" by content too (forwarded / test sends).
    // All three must be present -> very specific to Derix sheets.
    contentMarkers: [
      '\\b\\d{2}TR\\d{6}\\b', // TR reference
      '\\b\\d{2}BA\\d{6}\\b', // BA (factuur) reference
      '(Offener Sattel|Tele-Sattel|WB DX|Tiefbett|Planensattel|Dispoliste)',
    ],
  },

  // "Dit staat niet op de sheet maar is altijd ..." — fixed loading data.
  fixedFields: {
    pickup_name: 'Derix',
    pickup_address: 'Industriestrasse 24',
    pickup_country: 'DE',
    pickup_zipcode: '49492',
    pickup_city: 'Westerkappeln',
    pickup_contact: 'Nils Mindrup',
    pickup_phone: '00495456930356',
    pickup_email: 'transporte.wk@derix.de',
    // Goederen defaults.
    cargo_unit_amount: '1', // Aantal = altijd 1 per order
    cargo_unit_id: 'vracht', // Eenheid = altijd vracht (tenzij deellading)
    product_id: 'Constructie - Hout',
  },

  // Laad/Losreferentie = TR number; Factuurreferentie = BA number.
  referencePatterns: {
    pickup_reference: '\\b\\d{2}TR\\d{6}\\b',
    delivery_reference: '\\b\\d{2}TR\\d{6}\\b',
    invoice_reference: '\\b\\d{2}BA\\d{6}\\b',
  },

  // Transportsoort (zwarte balk) -> Pultrum transport_type.
  valueMaps: {
    transport_type: {
      'Offener Sattel': 'Platte X-Lam',
      'Tele-Sattel': 'Schuif trailer',
      'WB DX 12m': 'Platte X-Lam',
      'WB DX 16m': 'Schuif Trailer',
      Tiefbett: 'Semi Dieplader',
      Planensattel: 'Tautliner',
    },
  },

  // Deellading: meerdere LT-regels binnen een TR-blok = meerdere orders.
  split: { mode: 'deterministic', strategy: 'derix-tr-lt' },

  // Withagen (route R103) should be excluded, but Niek still has to confirm /
  // add it to the mapping before we activate the rule. Left inert on purpose.
  exclude: {
    // routePatterns: ['R103'],
    // partnerPatterns: ['Withagen'],
  },

  notes:
    'Chauffeur losinfo: altijd een foto maken van de getekende pakbon (lieferschein) en bijvoegen bij de E-CMR; eventuele wachttijden vermelden. Lengte/breedte notatie: punt = meters, komma = millimeters.',
};
