import {
  attachmentTypeCategory,
  concernsForDocumentType,
  isImageAttachment,
  isSignatureSizedImage,
  isXmlDocumentAttachment,
  normalizeDocumentPurpose,
  normalizeDocumentTypeRules,
  redactFiledataForPreview,
  resolveAttachmentDocumentType,
  xmlAttachmentConcerns,
  xmlAttachmentDocumentType,
} from './xml-documents';

describe('isXmlDocumentAttachment (Niek #4)', () => {
  const b64 = 'Zm9v'; // non-empty content

  it('excludes SMALL Outlook inline signature images (image001.png, ...)', () => {
    for (const name of [
      'image001.png',
      'image002.jpg',
      'image012.jpeg',
      'IMAGE003.GIF',
      'image1.webp',
    ]) {
      expect(
        isXmlDocumentAttachment({
          fileName: name,
          mimeType: 'image/png',
          contentBase64: b64,
          size: 3 * 1024, // signature-sized
        }),
      ).toBe(false);
    }
  });

  it('keeps a LARGE image00N — a real photo embedded in the body (Sander)', () => {
    // A site/access map is embedded inline and auto-named image003.jpg, but its
    // size gives it away as a real photo, not a signature logo.
    expect(
      isXmlDocumentAttachment({
        fileName: 'image003.jpg',
        mimeType: 'image/jpeg',
        contentBase64: b64,
        size: 960 * 1024,
      }),
    ).toBe(true);
  });

  it('keeps real photos and business documents', () => {
    expect(
      isXmlDocumentAttachment({
        fileName: 'route-unloading.jpg',
        mimeType: 'image/jpeg',
        contentBase64: b64,
      }),
    ).toBe(true);
    expect(
      isXmlDocumentAttachment({
        fileName: 'Dispoliste KW36.pdf',
        mimeType: 'application/pdf',
        contentBase64: b64,
      }),
    ).toBe(true);
    // Sander: the opdracht sheet is sometimes a .csv export.
    expect(
      isXmlDocumentAttachment({
        fileName: 'Pultrum bestelling.csv',
        mimeType: 'text/csv',
        contentBase64: b64,
      }),
    ).toBe(true);
    // A photo whose name isn't the Outlook auto-pattern stays included.
    expect(
      isXmlDocumentAttachment({
        fileName: 'IMG_2043.png',
        mimeType: 'image/png',
        contentBase64: b64,
      }),
    ).toBe(true);
  });

  it('still excludes attachments without content', () => {
    expect(
      isXmlDocumentAttachment({
        fileName: 'route.pdf',
        mimeType: 'application/pdf',
        contentBase64: '',
      }),
    ).toBe(false);
  });
});

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

  it('maps an explicit invoice/Factuurbijlage classification to 92', () => {
    expect(xmlAttachmentDocumentType('invoice')).toBe('92');
    expect(xmlAttachmentDocumentType('factuurbijlage')).toBe('92');
    expect(xmlAttachmentDocumentType('  Invoice ')).toBe('92');
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

  it('recognizes an explicit invoice/Factuurbijlage classification', () => {
    expect(normalizeDocumentPurpose('invoice')).toBe('invoice');
    expect(normalizeDocumentPurpose('factuurbijlage')).toBe('invoice');
  });

  it('returns null for absent/unknown values (so the doc stays 92)', () => {
    expect(normalizeDocumentPurpose(null)).toBeNull();
    expect(normalizeDocumentPurpose(undefined)).toBeNull();
    expect(normalizeDocumentPurpose('')).toBeNull();
    expect(normalizeDocumentPurpose('random-label')).toBeNull();
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

describe('attachmentTypeCategory / isImageAttachment (Sander 2026-09-09)', () => {
  it('categorizes by extension', () => {
    expect(attachmentTypeCategory('order.pdf')).toBe('pdf');
    expect(attachmentTypeCategory('brief.doc')).toBe('word');
    expect(attachmentTypeCategory('brief.docx')).toBe('word');
    expect(attachmentTypeCategory('opdracht.xls')).toBe('excel');
    expect(attachmentTypeCategory('opdracht.xlsx')).toBe('excel');
    // Sander's opdracht sheet is sometimes a .csv export.
    expect(attachmentTypeCategory('Pultrum bestelling.csv')).toBe('excel');
    expect(attachmentTypeCategory('bouwlocatie.jpg')).toBe('image');
    expect(attachmentTypeCategory('photo.PNG')).toBe('image');
    expect(attachmentTypeCategory('note.txt')).toBeNull();
  });

  it('falls back to the mime type when the name has no extension', () => {
    expect(attachmentTypeCategory('blob', 'application/pdf')).toBe('pdf');
    expect(attachmentTypeCategory('blob', 'image/webp')).toBe('image');
    expect(
      attachmentTypeCategory(
        'blob',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('excel');
  });

  it('isImageAttachment is true only for images', () => {
    expect(isImageAttachment('bouwlocatie.jpg', 'image/jpeg')).toBe(true);
    expect(isImageAttachment('order.pdf', 'application/pdf')).toBe(false);
    expect(isImageAttachment('opdracht.csv', 'text/csv')).toBe(false);
  });
});

describe('isSignatureSizedImage (photo vs logo by size)', () => {
  it('treats small images as signature-sized', () => {
    expect(isSignatureSizedImage(2 * 1024)).toBe(true);
    expect(isSignatureSizedImage(49 * 1024)).toBe(true);
  });

  it('treats large images as real photos', () => {
    expect(isSignatureSizedImage(60 * 1024)).toBe(false);
    expect(isSignatureSizedImage(960 * 1024)).toBe(false);
  });

  it('treats unknown/zero size as NOT a signature (keep it)', () => {
    expect(isSignatureSizedImage(undefined)).toBe(false);
    expect(isSignatureSizedImage(null)).toBe(false);
    expect(isSignatureSizedImage(0)).toBe(false);
  });
});

describe('normalizeDocumentTypeRules (Sander per-profile pin)', () => {
  it('keeps only known categories with numeric values', () => {
    expect(
      normalizeDocumentTypeRules({
        pdf: '91',
        excel: '87',
        image: 92, // number coerced
        word: '',
        bogus: '10',
        html: '5',
      }),
    ).toEqual({ pdf: '91', excel: '87', image: '92' });
  });

  it('returns {} for absent/malformed input', () => {
    expect(normalizeDocumentTypeRules(null)).toEqual({});
    expect(normalizeDocumentTypeRules(undefined)).toEqual({});
    expect(normalizeDocumentTypeRules('nope')).toEqual({});
    expect(normalizeDocumentTypeRules({ pdf: 'abc' })).toEqual({});
  });
});

describe('resolveAttachmentDocumentType (rule overrides AI)', () => {
  it('a matching profile rule wins over the AI purpose', () => {
    expect(
      resolveAttachmentDocumentType({
        fileName: 'opdracht.xlsx',
        documentPurpose: 'loading', // AI would say 86
        rules: { excel: '87' },
      }),
    ).toBe('87');
  });

  it('falls back to the AI purpose when no rule matches the file type', () => {
    // The excel rule must NOT apply to a pdf; the AI purpose (unloading) -> 87.
    expect(
      resolveAttachmentDocumentType({
        fileName: 'route.pdf',
        documentPurpose: 'unloading',
        rules: { excel: '87' },
      }),
    ).toBe('87');
  });

  it('pins an image documenttype even without an AI purpose', () => {
    expect(
      resolveAttachmentDocumentType({
        fileName: 'bouwlocatie.jpg',
        documentPurpose: null,
        rules: { image: '92' },
      }),
    ).toBe('92');
  });

  it('defaults to the AI mapping (92) with no rules', () => {
    expect(
      resolveAttachmentDocumentType({ fileName: 'x.pdf', rules: {} }),
    ).toBe('92');
  });
});

describe('redactFiledataForPreview', () => {
  it('elides each <filedata> body but keeps the tags and other content', () => {
    const xml =
      '<documents><document><filename>a.pdf</filename>' +
      '<filedata>QUJDREVGRw==</filedata></document>' +
      '<document><filename>b.eml</filename>' +
      '<filedata>WFlaMTIz</filedata></document></documents>';
    const out = redactFiledataForPreview(xml);
    expect(out).not.toContain('QUJDREVHRw==');
    expect(out).not.toContain('WFlaMTIz');
    expect(out).toContain('<filename>a.pdf</filename>');
    expect(out).toContain('<filename>b.eml</filename>');
    // The size hint is present for each elided block.
    expect(out).toContain('base64 chars, elided for preview');
    expect((out.match(/<filedata>/g) ?? []).length).toBe(2);
  });

  it('is a no-op when there is no <filedata>', () => {
    const xml = '<shipment><reference>J1</reference></shipment>';
    expect(redactFiledataForPreview(xml)).toBe(xml);
  });
});

describe('concernsForDocumentType', () => {
  it('labels the known Transpas codes', () => {
    expect(concernsForDocumentType('86')).toBe('Document laden');
    expect(concernsForDocumentType('87')).toBe('Document lossen');
    expect(concernsForDocumentType('91')).toBe('Document laden/lossen');
    expect(concernsForDocumentType('19')).toBe('E-mail');
    expect(concernsForDocumentType('92')).toBe('Bijlage');
    expect(concernsForDocumentType('123')).toBe('Bijlage');
  });
});
