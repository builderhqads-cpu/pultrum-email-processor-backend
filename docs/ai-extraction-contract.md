# AI Extraction Contract — `/extract-transport-order`

How the Pultrum pipeline calls the extraction route and what it expects back.
Match this contract so the response is read correctly **and** extracts the full
set of fields (not only the required gaps).

- **Method:** `POST`
- **URL:** `${AI_API_BASE_URL}/extract-transport-order`
- **Headers:** `Content-Type: application/json` and, if configured, `Authorization: Bearer <AI_API_KEY>`

---

## 1. Request body (what we send)

```jsonc
{
  "orderId": "uuid",
  "customerEmail": "client@example.com",
  "subject": "string | null",
  "bodyText": "string | null",
  "attachmentsText": "string | null",   // text from DOCX/PDF/OCR, or null
  "combinedText": "subject + body + attachments — PRIMARY input for the model",
  "language": "nl | en | pt | ...",
  "department": "OPEN_TRANSPORT | STUK_GOED | null",

  "requiredFields": [                    // THE FULL FIELD CATALOG (see §3)
    {
      "key": "pickup_city",
      "label": "Pickup city",
      "aliases": ["pickup city", "laadplaats", "..."],
      "xmlPath": "transportbooking.shipments.shipment.pickupaddress.city_id",
      "requirement": "REQUIRED | RECOMMENDED | OPTIONAL",
      "generated": true,                 // optional flag — DO NOT extract (see §3)
      "calculable": true                 // optional flag — DO NOT extract (see §3)
    }
    // ... ~80 entries
  ],

  "detectedFields": [                    // already found by regex/labels (may be empty)
    { "key": "pickup_city", "label": "Pickup city", "value": "Rotterdam", "confidence": 0.9 }
  ],

  "missingFields": [                     // PRIORITY HINT ONLY — not the limit (see §3)
    { "key": "pickup_date", "label": "Pickup date", "reason": "Not detected in email content", "requirement": "REQUIRED" }
  ],

  "emailMetadata": { "fromName": "...", "fromEmail": "...", "receivedAt": "ISO-8601" }
}
```

## 2. Response body (what we read)

The parser is flexible — it accepts `fields` as an **array** or a **map**, and it
also looks inside `data` / `choices` / `output` / `tool_calls`. Recommended shape:

```jsonc
{
  "fields": [
    { "key": "pickup_city", "label": "Pickup city", "value": "Padborg", "confidence": 1.0 }
  ],
  "missingFields": [
    { "key": "cargo_weight", "label": "Cargo weight", "reason": "not mentioned in the email" }
  ]
}
```

Equivalent map form is also accepted (confidence defaults to `0.85`):

```jsonc
{ "fields": { "pickup_city": "Padborg", "delivery_city": "Hanau" } }
```

**Rules:**
- `fields` (required to be useful): each item `{ key, label, value, confidence }`.
  `key` / `label` **must match exactly** the values we sent in `requiredFields`.
- `confidence`: number `0..1`, max 2 decimals.
- `missingFields` (optional): `{ key, label, reason }` for catalog fields **not**
  supported by the text.
- Extra fields (`model`, `usage`, `output`, `prompt`, …) are ignored.
- Return **HTTP 200** with `Content-Type: application/json`. On any error / timeout /
  missing `fields`, the pipeline fails safe (the order is simply not AI-filled — it
  is never dropped).

---

## 3. ⚠️ Extract over the FULL catalog, not just `missingFields`

This is the most important point. The model must try to fill **every extractable
field in `requiredFields`** — using `combinedText` — and use `missingFields` only as
a priority hint.

**Build the extractable catalog** from `requiredFields`, excluding:
- `generated: true`  → produced by our system (e.g. barcodes, EDI refs)
- `calculable: true` → computed by our system (e.g. loading meter, volume)
- the denylist keys: `weight`, `unit_amount`, `unit_id`, `price` (handled elsewhere;
  use the cargo-prefixed `cargo_weight`, `cargo_unit_amount`, `cargo_unit_id` and
  `fixed_price` instead)

Then, for **each** remaining catalog field, decide if the value appears in the text;
put it in `fields` if found, otherwise in `missingFields`.

> Iterating only `missingFields` (the required gaps) is the old "gap-filler" approach
> and **under-extracts** — all RECOMMENDED data in the email (times, names, contacts,
> references, dimensions, price, …) is lost. Offering the full catalog also improves
> accuracy: with `product_id` and `pickup_time` available, the model stops dumping
> the product number into `cargo_unit_id` or the time into `pickup_date`.

---

## 4. Worked example

Dutch email (abridged): pickup 1 June 2026 10:00 at E3 Spedition-Transport A/S,
Transitvej 16, 6330 Padborg (DK), contact John Hansen +4512345678
pickup@example.com, ref REF123 — delivery 2 June 2026 12:00 at Systro Gastronomie
GmbH, Rodgaustraße 7, 63457 Hanau (DE), contact Maria Schmidt +4912345678
delivery@example.com, ref LOS789 — 5 colli of product 1109, 50 kg, 20×20×90 cm,
standard transport, invoice 1234567890, price €250.

### ❌ Current output (only the 13 required gaps)

`pickup_date="1 juni 2026 om 10:00 uur"` (date+time merged),
`pickup_address`, `pickup_country`, `pickup_zipcode`, `pickup_city`,
`delivery_date="2 juni 2026 om 12:00 uur"`, `delivery_address`, `delivery_country`,
`delivery_zipcode`, `delivery_city`, `cargo_unit_amount="5"`,
`cargo_unit_id="1109"` (wrong — that is the product), `invoice_reference`.

### ✅ Expected output (full catalog)

```json
{
  "fields": [
    { "key": "pickup_date", "label": "Pickup date", "value": "1 juni 2026", "confidence": 1.0 },
    { "key": "pickup_time", "label": "Pickup time", "value": "10:00", "confidence": 1.0 },
    { "key": "pickup_name", "label": "Pickup name", "value": "E3 Spedition-Transport A/S", "confidence": 1.0 },
    { "key": "pickup_reference", "label": "Pickup reference", "value": "REF123", "confidence": 1.0 },
    { "key": "pickup_address", "label": "Pickup address", "value": "Transitvej 16", "confidence": 1.0 },
    { "key": "pickup_zipcode", "label": "Pickup zipcode", "value": "6330", "confidence": 1.0 },
    { "key": "pickup_city", "label": "Pickup city", "value": "Padborg", "confidence": 1.0 },
    { "key": "pickup_country", "label": "Pickup country", "value": "Denemarken", "confidence": 1.0 },
    { "key": "pickup_contact", "label": "Pickup contact", "value": "John Hansen", "confidence": 1.0 },
    { "key": "pickup_phone", "label": "Pickup phone", "value": "+4512345678", "confidence": 1.0 },
    { "key": "pickup_email", "label": "Pickup email", "value": "pickup@example.com", "confidence": 1.0 },
    { "key": "delivery_date", "label": "Delivery date", "value": "2 juni 2026", "confidence": 1.0 },
    { "key": "delivery_time", "label": "Delivery time", "value": "12:00", "confidence": 1.0 },
    { "key": "delivery_name", "label": "Delivery name", "value": "Systro Gastronomie GmbH", "confidence": 1.0 },
    { "key": "delivery_reference", "label": "Delivery reference", "value": "LOS789", "confidence": 1.0 },
    { "key": "delivery_address", "label": "Delivery address", "value": "Rodgaustraße 7", "confidence": 1.0 },
    { "key": "delivery_zipcode", "label": "Delivery zipcode", "value": "63457", "confidence": 1.0 },
    { "key": "delivery_city", "label": "Delivery city", "value": "Hanau", "confidence": 1.0 },
    { "key": "delivery_country", "label": "Delivery country", "value": "Duitsland", "confidence": 1.0 },
    { "key": "delivery_contact", "label": "Delivery contact", "value": "Maria Schmidt", "confidence": 1.0 },
    { "key": "delivery_phone", "label": "Delivery phone", "value": "+4912345678", "confidence": 1.0 },
    { "key": "delivery_email", "label": "Delivery email", "value": "delivery@example.com", "confidence": 1.0 },
    { "key": "cargo_unit_amount", "label": "Cargo unit amount", "value": "5", "confidence": 1.0 },
    { "key": "cargo_unit_id", "label": "Cargo unit id", "value": "colli", "confidence": 0.9 },
    { "key": "cargo_weight", "label": "Cargo weight", "value": "50", "confidence": 1.0 },
    { "key": "product_id", "label": "Product", "value": "1109", "confidence": 1.0 },
    { "key": "length", "label": "Length", "value": "20", "confidence": 1.0 },
    { "key": "width", "label": "Width", "value": "20", "confidence": 1.0 },
    { "key": "height", "label": "Height", "value": "90", "confidence": 1.0 },
    { "key": "transport_type", "label": "Transport type", "value": "standaard", "confidence": 0.9 },
    { "key": "invoice_reference", "label": "Invoice reference", "value": "1234567890", "confidence": 1.0 },
    { "key": "fixed_price", "label": "Fixed price", "value": "250", "confidence": 1.0 }
  ],
  "missingFields": []
}
```

Note the corrections vs the current output: `pickup_date` / `delivery_date` hold the
date only (time goes to `pickup_time` / `delivery_time`), `product_id` gets `1109`,
and `cargo_unit_id` gets the packaging unit (`colli`) — not the product number.
