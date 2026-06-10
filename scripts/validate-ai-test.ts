/**
 * Targeted validation of the /ai-test extraction + reply services against the
 * real OpenRouter API, using the Dutch sample email. No DB/Redis/Graph needed.
 *
 * Run: npx ts-node --transpile-only scripts/validate-ai-test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { OpenRouterExtractionService } from '../src/modules/ai-extraction/openrouter-extraction.service';
import { OpenRouterReplyService } from '../src/modules/ai-reply/openrouter-reply.service';

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, '..', '.env');
  const out: Record<string, string> = {};
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = loadEnv();
const configStub: any = { get: (k: string) => env[k] };

const bodyText = [
  'Goedemorgen,',
  '',
  'Graag wil ik een transportopdracht aanvragen voor een zending die op 1 juni 2026 om 10:00 uur opgehaald moet worden bij E3 Spedition-Transport A/S aan de Transitvej 16 in 6330 Padborg, Denemarken. De contactpersoon voor het laden is John Hansen. Hij is bereikbaar via telefoonnummer +4512345678 en via e-mail pickup@example.com. De laadreferentie voor deze zending is REF123.',
  '',
  'De levering dient plaats te vinden op 2 juni 2026 om 12:00 uur bij Systro Gastronomie GmbH, gevestigd aan de Rodgaustraße 7 in 63457 Hanau, Duitsland. De contactpersoon voor de levering is Maria Schmidt. Zij is bereikbaar via telefoonnummer +4912345678 en via e-mail delivery@example.com. De losreferentie is LOS789.',
  '',
  'De zending bestaat uit 5 colli van product 1109 met een totaalgewicht van 50 kilogram. De afmetingen per collo zijn 20 cm lang, 20 cm breed en 90 cm hoog.',
  '',
  'Het betreft standaard transport. De factuurreferentie voor deze opdracht is 1234567890 en de overeengekomen transportprijs bedraagt €250.',
  '',
  'Met vriendelijke groet,',
].join('\n');

const subject = 'Transportopdracht Padborg naar Hanau';
const combinedText = `Subject:\n${subject}\n\nBodyText:\n${bodyText}`;

// The fields the deterministic parser would report as missing (REQUIRED-only),
// mirroring the real pipeline. RECOMMENDED fields are intentionally NOT here.
const requiredMissing = [
  'pickup_date',
  'pickup_address',
  'pickup_country',
  'pickup_zipcode',
  'pickup_city',
  'delivery_date',
  'delivery_address',
  'delivery_country',
  'delivery_zipcode',
  'delivery_city',
  'cargo_unit_amount',
  'cargo_unit_id',
  'invoice_reference',
].map((key) => ({ key, label: key, reason: 'Not detected in email content' }));

// Fields we specifically want to see the AI recover even though they are NOT in
// missingFields (these are the RECOMMENDED fields that used to be dropped).
const WATCH = [
  'pickup_reference',
  'pickup_time',
  'pickup_name',
  'pickup_contact',
  'pickup_phone',
  'delivery_reference',
  'delivery_time',
  'delivery_name',
  'delivery_contact',
  'delivery_phone',
  'cargo_weight',
  'product_id',
  'length',
  'width',
  'height',
  'transport_type',
  'fixed_price',
];

async function main() {
  if (!env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not found in .env — cannot validate.');
    process.exit(1);
  }

  console.log('=== 1) EXTRACTION (/ai-test/extract-transport-order) ===');
  const extraction = new OpenRouterExtractionService(configStub);
  const exResult = await extraction.extractTransportOrder({
    orderId: 'validate-1',
    customerEmail: 'renatoscardoso77@gmail.com',
    subject,
    bodyText,
    attachmentsText: null,
    combinedText,
    requiredFields: [],
    detectedFields: [],
    missingFields: requiredMissing,
    department: 'OPEN_TRANSPORT',
    language: 'nl',
  } as any);

  const fields = exResult.fields ?? {};
  const keys = Object.keys(fields).sort();
  console.log(`Total fields returned: ${keys.length}`);
  console.log('Fields:', JSON.stringify(fields, null, 2));

  const recovered = WATCH.filter((k) => fields[k] && String(fields[k]).trim());
  const stillMissing = WATCH.filter((k) => !(fields[k] && String(fields[k]).trim()));
  console.log(`\nRECOMMENDED fields recovered (${recovered.length}/${WATCH.length}): ${recovered.join(', ')}`);
  if (stillMissing.length) {
    console.log(`Still missing from WATCH list: ${stillMissing.join(', ')}`);
  }

  console.log('\n=== 2) REPLY (/ai-test/generate-missing-info-reply) ===');
  const reply = new OpenRouterReplyService(configStub);
  const rpResult = await reply.generateMissingInfoReply({
    orderId: 'validate-1',
    customerEmail: 'renatoscardoso77@gmail.com',
    subject,
    bodyText,
    language: 'nl',
    detectedFields: [],
    // Required gap -> blocking bullet
    missingFields: [{ key: 'pickup_zipcode', label: 'Pickup zipcode', reason: 'Missing' }],
    // Recommended gaps -> non-blocking "also helpful" line (the part we fixed)
    validationWarnings: [
      { key: 'pickup_phone', label: 'Pickup phone', reason: 'Recommended' },
      { key: 'pickup_contact', label: 'Pickup contact', reason: 'Recommended' },
    ],
  } as any);

  console.log('Subject:', rpResult.subject);
  console.log('Body:\n' + rpResult.body);

  const hasBlocking = rpResult.body.includes('- Pickup zipcode');
  // Locale-aware: the helpful line is rendered in nl/pt/en depending on language.
  const hasHelpful =
    /(helpful to receive|nuttig om mee te sturen|util receber):.*Pickup phone.*Pickup contact/i.test(
      rpResult.body,
    );
  console.log(`\nBlocking bullet present (Pickup zipcode): ${hasBlocking}`);
  console.log(`Recommended "also helpful" line present: ${hasHelpful}`);

  console.log('\n=== SUMMARY ===');
  console.log(`Extraction recovered ${recovered.length}/${WATCH.length} RECOMMENDED fields.`);
  console.log(`Reply blocking=${hasBlocking} helpful=${hasHelpful}`);
}

main().catch((err) => {
  console.error('Validation failed:', err?.message ?? err);
  process.exit(1);
});
