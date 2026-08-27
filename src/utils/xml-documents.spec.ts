import {
  normalizeDocumentPurpose,
  xmlAttachmentConcerns,
  xmlAttachmentDocumentType,
} from './xml-documents';

describe('xmlAttachmentDocumentType (Niek #6)', () => {
  it('maps loading/unloading/both to 86/87/91 (EN and NL synonyms)', () => {
    expect(xmlAttachmentDocumentType('loading')).toBe('86');
    expect(xmlAttachmentDocumentType('laden')).toBe('86');
    expect(xmlAttachmentDocumentType('unloading')).toBe('87');
    expect(xmlAttachmentDocumentType('lossen')).toBe('87');
    expect(xmlAttachmentDocumentType('both')).toBe('91');
    expect(xmlAttachmentDocumentType('beide')).toBe('91');
    expect(xmlAttachmentDocumentType('laden/lossen')).toBe('91');
  });

  it('is case/space insensitive', () => {
    expect(xmlAttachmentDocumentType('  LOADING ')).toBe('86');
    expect(xmlAttachmentDocumentType('Unloading')).toBe('87');
  });

  it('defaults to 92 (Factuurbijlage) when the purpose is absent/unknown', () => {
    expect(xmlAttachmentDocumentType(null)).toBe('92');
    expect(xmlAttachmentDocumentType(undefined)).toBe('92');
    expect(xmlAttachmentDocumentType('')).toBe('92');
    expect(xmlAttachmentDocumentType('something-else')).toBe('92');
  });

  it('concerns label matches the mapped type', () => {
    expect(xmlAttachmentConcerns('loading')).toBe('Document laden');
    expect(xmlAttachmentConcerns('unloading')).toBe('Document lossen');
    expect(xmlAttachmentConcerns('both')).toBe('Document laden/lossen');
    expect(xmlAttachmentConcerns(null)).toBe('Bijlage');
  });
});

describe('normalizeDocumentPurpose (Niek #6)', () => {
  it('canonicalizes EN + NL synonyms', () => {
    expect(normalizeDocumentPurpose('loading')).toBe('loading');
    expect(normalizeDocumentPurpose('laden')).toBe('loading');
    expect(normalizeDocumentPurpose('unloading')).toBe('unloading');
    expect(normalizeDocumentPurpose('lossen')).toBe('unloading');
    expect(normalizeDocumentPurpose('both')).toBe('both');
    expect(normalizeDocumentPurpose('beide')).toBe('both');
    expect(normalizeDocumentPurpose('laden/lossen')).toBe('both');
  });

  it('is case/space insensitive', () => {
    expect(normalizeDocumentPurpose('  BOTH ')).toBe('both');
    expect(normalizeDocumentPurpose('Loading')).toBe('loading');
  });

  it('returns null for absent/unknown values (so the doc stays 92)', () => {
    expect(normalizeDocumentPurpose(null)).toBeNull();
    expect(normalizeDocumentPurpose(undefined)).toBeNull();
    expect(normalizeDocumentPurpose('')).toBeNull();
    expect(normalizeDocumentPurpose('invoice')).toBeNull();
  });

  it('round-trips through the XML type mapping', () => {
    expect(
      xmlAttachmentDocumentType(normalizeDocumentPurpose('both')),
    ).toBe('91');
    expect(
      xmlAttachmentDocumentType(normalizeDocumentPurpose('laden')),
    ).toBe('86');
    expect(
      xmlAttachmentDocumentType(normalizeDocumentPurpose('bogus')),
    ).toBe('92');
  });
});
