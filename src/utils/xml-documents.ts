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
