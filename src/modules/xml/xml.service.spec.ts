import { XmlService } from './xml.service';
import { create } from 'xmlbuilder2';

type XmlServiceInternals = {
  assertNoUnsafeHtml(xmlPayload: string): void;
  appendOriginalDocuments(
    shipmentNode: ReturnType<typeof create>,
    emailMessage:
      | {
          id: string;
          rawMimeBase64?: string | null;
          rawMimeFileName?: string | null;
          rawMimeMimeType?: string | null;
          attachments?: Array<{
            fileName: string;
            mimeType: string;
            contentBase64?: string | null;
          }>;
        }
      | null
      | undefined,
  ): void;
};

describe('XmlService unsafe HTML guard', () => {
  it('throws when XML contains unsafe fragments', () => {
    const service = new XmlService({} as any, {} as any) as unknown as XmlServiceInternals;

    expect(() =>
      service.assertNoUnsafeHtml('<root>123&lt;br&gt;</root>'),
    ).toThrow(
      'XML contains unsafe HTML fragments. Sanitize extracted fields before generating XML.',
    );

    expect(() => service.assertNoUnsafeHtml('<root>123<br></root>')).toThrow(
      'XML contains unsafe HTML fragments. Sanitize extracted fields before generating XML.',
    );
  });

  it('does not throw for clean XML', () => {
    const service = new XmlService({} as any, {} as any) as unknown as XmlServiceInternals;
    expect(() =>
      service.assertNoUnsafeHtml(
        '<?xml version="1.0"?><transportbookings></transportbookings>',
      ),
    ).not.toThrow();
  });
});

describe('XmlService original documents packaging', () => {
  // Note: inline logo/signature images are filtered out upstream (graph.service),
  // so any image that reaches the XML layer is treated as a real attachment.
  it('appends original email and supported business attachments as base64 documents', () => {
    const service = new XmlService({} as any, {} as any) as unknown as XmlServiceInternals;
    const shipment = create({ version: '1.0', encoding: 'UTF-8' }).ele(
      'shipment',
    );

    service.appendOriginalDocuments(shipment, {
      id: 'email-1',
      rawMimeBase64: 'ZW1sLWNvbnRlbnQ=',
      rawMimeFileName: 'Transport Request 003.eml',
      rawMimeMimeType: 'message/rfc822',
      attachments: [
        {
          fileName: 'order.pdf',
          mimeType: 'application/pdf',
          contentBase64: 'cGRmLWNvbnRlbnQ=',
        },
        {
          fileName: 'access-route.jpg',
          mimeType: 'image/jpeg',
          contentBase64: 'anBnLWNvbnRlbnQ=',
        },
        {
          fileName: 'rates.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentBase64: 'eGxzeC1jb250ZW50',
        },
        {
          fileName: 'empty.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          contentBase64: null,
        },
      ],
    });

    const xml = shipment.doc().end({ prettyPrint: true });

    expect(xml).toContain('<documents>');
    expect(xml).toContain('<documenttype>email-original</documenttype>');
    expect(xml).toContain('<filename>Transport Request 003.eml</filename>');
    expect(xml).toContain('<mimetype>message/rfc822</mimetype>');
    expect(xml).toContain('<contentbase64>ZW1sLWNvbnRlbnQ=</contentbase64>');

    expect(xml).toContain('<filename>order.pdf</filename>');
    expect(xml).toContain('<mimetype>application/pdf</mimetype>');
    expect(xml).toContain('<contentbase64>cGRmLWNvbnRlbnQ=</contentbase64>');

    expect(xml).toContain('<filename>rates.xlsx</filename>');
    expect(xml).toContain(
      '<mimetype>application/vnd.openxmlformats-officedocument.spreadsheetml.sheet</mimetype>',
    );
    expect(xml).toContain('<contentbase64>eGxzeC1jb250ZW50</contentbase64>');

    // A real image attachment (e.g. an access route) is now packaged too.
    expect(xml).toContain('<filename>access-route.jpg</filename>');
    expect(xml).toContain('<mimetype>image/jpeg</mimetype>');

    // No content -> not attached.
    expect(xml).not.toContain('empty.docx');
  });

  it('does not append a documents block when no eligible payload exists', () => {
    const service = new XmlService({} as any, {} as any) as unknown as XmlServiceInternals;
    const shipment = create({ version: '1.0', encoding: 'UTF-8' }).ele(
      'shipment',
    );

    service.appendOriginalDocuments(shipment, {
      id: 'email-2',
      rawMimeBase64: null,
      attachments: [
        {
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          contentBase64: 'dHh0LWNvbnRlbnQ=',
        },
      ],
    });

    const xml = shipment.doc().end({ prettyPrint: true });
    expect(xml).not.toContain('<documents>');
  });
});
