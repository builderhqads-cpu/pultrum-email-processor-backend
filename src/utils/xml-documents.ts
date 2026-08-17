/**
 * Helpers describing which email attachments the Creative Gears XML embeds as
 * `<document>` entries. Shared by the XML builder (which actually embeds them)
 * and the emails API (which flags each attachment as `includedInXml` for the
 * UI), so the two never drift apart.
 */

/**
 * True for attachments the XML embeds as a business `<document>`: PDF / Word /
 * Excel plus REAL image attachments (e.g. an access-route photo). Inline
 * logo/signature images are already dropped at Graph ingestion, so they never
 * reach here. Requires actual content (base64).
 */
export function isXmlDocumentAttachment(input: {
  fileName?: string | null;
  mimeType?: string | null;
  contentBase64?: string | null;
}): boolean {
  if (!input.contentBase64?.trim()) return false;

  const mime = (input.mimeType || '').trim().toLowerCase();
  const fileName = (input.fileName || '').trim().toLowerCase();

  return (
    mime === 'application/pdf' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    fileName.endsWith('.pdf') ||
    fileName.endsWith('.doc') ||
    fileName.endsWith('.docx') ||
    fileName.endsWith('.xls') ||
    fileName.endsWith('.xlsx') ||
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
    default:
      return '92';
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
