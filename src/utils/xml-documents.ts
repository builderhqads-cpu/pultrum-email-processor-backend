/**
 * Helpers describing which email attachments the Creative Gears XML embeds as
 * `<document>` entries. Shared by the XML builder (which actually embeds them)
 * and the emails API (which flags each attachment as `includedInXml` for the
 * UI), so the two never drift apart.
 */

/**
 * A body-embedded image (inline / Content-ID) is a signature logo or social
 * icon when it is SMALL; a large one is a real photo (a site/access map). Used
 * both at mail ingestion (drop signatures, keep photos) and by the XML document
 * filter, so the two agree. Unknown/zero size => not a signature (keep it — a
 * real photo must never be dropped just because its size is unknown). Threshold
 * is SIGNATURE_IMAGE_MAX_KB (default 50 KB).
 */
export function signatureImageMaxBytes(): number {
  const kb = Number(process.env.SIGNATURE_IMAGE_MAX_KB || '50') || 50;
  return kb * 1024;
}

export function isSignatureSizedImage(size?: number | null): boolean {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return false;
  }
  return size <= signatureImageMaxBytes();
}

/**
 * True for attachments the XML embeds as a business `<document>`: PDF / Word /
 * Excel / CSV plus REAL image attachments (e.g. an access-route photo). Small
 * inline logo/signature images are dropped (at ingestion and here). Requires
 * actual content (base64).
 */
export function isXmlDocumentAttachment(input: {
  fileName?: string | null;
  mimeType?: string | null;
  contentBase64?: string | null;
  size?: number | null;
}): boolean {
  if (!input.contentBase64?.trim()) return false;

  const mime = (input.mimeType || '').trim().toLowerCase();
  const fileName = (input.fileName || '').trim().toLowerCase();

  // Niek #4: Outlook embeds signature logos/icons as INLINE images auto-named
  // image001.png, image002.jpg, ... These are not business documents. But a REAL
  // photo embedded in the body (e.g. a site/access map, Sander 2026-09-09) also
  // gets an image00N name — so the name alone isn't enough. Only drop the
  // auto-named image when it is ALSO signature-sized (small); a large image00N
  // is a real photo and stays a document.
  if (
    /^image\d+\.(png|jpe?g|gif|bmp|webp)$/.test(fileName) &&
    isSignatureSizedImage(input.size)
  ) {
    return false;
  }

  return (
    mime === 'application/pdf' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    // Sander: the opdracht sheet is sometimes exported as .csv — it must be
    // embedded in the XML (and read by the AI) like the Excel version.
    mime === 'text/csv' ||
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    fileName.endsWith('.pdf') ||
    fileName.endsWith('.doc') ||
    fileName.endsWith('.docx') ||
    fileName.endsWith('.xls') ||
    fileName.endsWith('.xlsx') ||
    fileName.endsWith('.csv') ||
    fileName.endsWith('.jpg') ||
    fileName.endsWith('.jpeg') ||
    fileName.endsWith('.png') ||
    fileName.endsWith('.webp')
  );
}

/**
 * Niek #6: map a document's PURPOSE to the Transpas `documenttype_id` for the
 * `<documents>` block. The purpose (loading / unloading / both) is decided by
 * the AI extraction, which matches each document (access/exit-route photo/PDF)
 * to the order's pickup vs delivery address — see Niek 2026-08-15. Until a
 * document carries that classification we emit 92 (Factuurbijlage), i.e. the
 * current behaviour, so this is a no-op until the extraction supplies a purpose.
 *
 *   86 = Document laden (loading)
 *   87 = Document lossen (unloading)
 *   91 = Document laden/lossen (both)
 *   92 = Factuurbijlage (default — unclassified attachment)
 */
export function xmlAttachmentDocumentType(purpose?: string | null): string {
  switch ((purpose ?? '').trim().toLowerCase()) {
    case 'loading':
    case 'laden':
      return '86';
    case 'unloading':
    case 'lossen':
      return '87';
    case 'both':
    case 'beide':
    case 'laden/lossen':
      return '91';
    // Explicit invoice classification maps to 92, same as the unclassified
    // default — but recognised on purpose so the AI can say "this is an invoice".
    case 'invoice':
    case 'factuurbijlage':
      return '92';
    default:
      return '92';
  }
}

/**
 * Niek #6: normalize the AI's raw attachment classification to the canonical
 * purpose we persist and emit — 'loading' | 'unloading' | 'both', or null when
 * the attachment is not a loading/unloading document (it then goes out as 92).
 * Tolerates the Dutch synonyms the XML mapping also accepts.
 */
export function normalizeDocumentPurpose(
  value?: string | null,
): 'loading' | 'unloading' | 'both' | 'invoice' | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'loading':
    case 'laden':
      return 'loading';
    case 'unloading':
    case 'lossen':
      return 'unloading';
    case 'both':
    case 'beide':
    case 'laden/lossen':
      return 'both';
    // Persist an explicit invoice classification (still emits 92) so it is
    // distinguishable from "not classified" (null) in the panel/audit.
    case 'invoice':
    case 'factuurbijlage':
      return 'invoice';
    default:
      return null;
  }
}

/** Human "concerns" label for a document, matching its purpose. */
export function xmlAttachmentConcerns(purpose?: string | null): string {
  switch (xmlAttachmentDocumentType(purpose)) {
    case '86':
      return 'Document laden';
    case '87':
      return 'Document lossen';
    case '91':
      return 'Document laden/lossen';
    default:
      return 'Bijlage';
  }
}

/**
 * Sander/Niek (2026-09-09): the AI's per-document judgement sometimes picks the
 * wrong documenttype. A customer profile can pin the Transpas documenttype by
 * FILE TYPE instead — e.g. for this client every Excel (the opdracht) is 87,
 * every PDF is 91, every photo is 92. The rule, when present, OVERRIDES the AI.
 * Categories are coarse (not raw extensions) so one rule covers doc+docx, etc.
 */
export type DocumentTypeRuleCategory = 'pdf' | 'word' | 'excel' | 'image';

export const DOCUMENT_TYPE_RULE_CATEGORIES: DocumentTypeRuleCategory[] = [
  'pdf',
  'word',
  'excel',
  'image',
];

/**
 * Coarse file-type category of an attachment (for the per-profile documenttype
 * rules and the "images never go to the AI" filter). null = uncategorized.
 * CSV counts as 'excel' (Sander's opdracht sheet is sometimes a .csv export).
 */
export function attachmentTypeCategory(
  fileName?: string | null,
  mimeType?: string | null,
): DocumentTypeRuleCategory | null {
  const name = (fileName || '').trim().toLowerCase();
  const mime = (mimeType || '').trim().toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (
    ext === 'doc' ||
    ext === 'docx' ||
    mime === 'application/msword' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'word';
  }
  if (
    ext === 'xls' ||
    ext === 'xlsx' ||
    ext === 'csv' ||
    mime === 'application/vnd.ms-excel' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'text/csv'
  ) {
    return 'excel';
  }
  if (
    ext === 'jpg' ||
    ext === 'jpeg' ||
    ext === 'png' ||
    ext === 'webp' ||
    ext === 'gif' ||
    ext === 'bmp' ||
    mime.startsWith('image/')
  ) {
    return 'image';
  }
  return null;
}

/**
 * True for image attachments (jpg/png/webp/...). Sander (2026-09-09): images are
 * meant for the driver (access-route photo), not for the AI to read — they must
 * NOT be sent to the extraction router, but STILL go into the XML as documents.
 */
export function isImageAttachment(
  fileName?: string | null,
  mimeType?: string | null,
): boolean {
  return attachmentTypeCategory(fileName, mimeType) === 'image';
}

/**
 * Parse/validate a raw per-profile documenttype-rules map (persisted as JSON on
 * the customer profile). Keeps only known categories whose value is a plain
 * numeric documenttype string; everything else is dropped. Returns {} when the
 * input is absent or malformed, so callers can treat "no rules" uniformly.
 */
export function normalizeDocumentTypeRules(
  raw: unknown,
): Partial<Record<DocumentTypeRuleCategory, string>> {
  const out: Partial<Record<DocumentTypeRuleCategory, string>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const category of DOCUMENT_TYPE_RULE_CATEGORIES) {
    const value = (raw as Record<string, unknown>)[category];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) out[category] = s;
  }
  return out;
}

/**
 * Final Transpas documenttype for an attachment: a matching per-profile rule
 * wins (Sander's file-type pin), otherwise the AI-derived purpose mapping
 * (86/87/91) or the 92 default. This is the single source of truth used by the
 * XML builder and the emails API's `includedInXml` preview.
 */
export function resolveAttachmentDocumentType(params: {
  fileName?: string | null;
  mimeType?: string | null;
  documentPurpose?: string | null;
  rules?: Partial<Record<DocumentTypeRuleCategory, string>> | null;
}): string {
  const category = attachmentTypeCategory(params.fileName, params.mimeType);
  const ruleType = category ? params.rules?.[category] : undefined;
  if (ruleType) return ruleType;
  return xmlAttachmentDocumentType(params.documentPurpose);
}

/**
 * For DISPLAY only: replace each `<filedata>` base64 body with a short
 * placeholder showing its size. The delivered XML embeds the full .eml +
 * attachments as base64 (several MB), which makes the portal preview unreadable
 * — this keeps the tag structure but drops the payload. Never used on the XML
 * actually sent to Creative Gears.
 */
export function redactFiledataForPreview(xml: string): string {
  return xml.replace(
    /(<filedata>)([\s\S]*?)(<\/filedata>)/g,
    (_match, open: string, data: string, close: string) =>
      `${open}…(${data.trim().length} base64 chars, elided for preview)…${close}`,
  );
}

/**
 * Transpas documenttype for the original e-mail (.eml) document, per
 * Rick/ArtSystems (2026-08-06). Kept as a shared constant so the XML builder and
 * the emails API never disagree on the e-mail's type.
 */
export const EMAIL_DOCUMENT_TYPE = '19';

/** Human "concerns" label for a resolved documenttype code. */
export function concernsForDocumentType(documentType?: string | null): string {
  switch ((documentType ?? '').trim()) {
    case '86':
      return 'Document laden';
    case '87':
      return 'Document lossen';
    case '91':
      return 'Document laden/lossen';
    case '18':
    case '19':
      return 'E-mail';
    default:
      return 'Bijlage';
  }
}

/**
 * Whether the `<documents>` block is included in the Creative Gears XML at all
 * (CREATIVE_GEARS_INCLUDE_DOCUMENTS, default on). When off, nothing is embedded.
 */
export function xmlDocumentsEnabled(): boolean {
  return (
    (process.env.CREATIVE_GEARS_INCLUDE_DOCUMENTS ?? 'true')
      .trim()
      .toLowerCase() !== 'false'
  );
}
