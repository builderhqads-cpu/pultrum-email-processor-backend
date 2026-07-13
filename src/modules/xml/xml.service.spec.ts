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

describe('XmlService generateOrderXml normalization', () => {
  it('recalculates stale calculated fields and fixes mojibake before serializing', async () => {
    const prisma = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          status: 'READY_TO_XML',
          department: 'OPEN_TRANSPORT',
          customerEmail: 'customer@example.com',
          missingFields: [],
          fields: [
            { key: 'invoice_reference', value: 'INV-2026-1507' },
            { key: 'pickup_reference', value: 'PU-2026-1507' },
            { key: 'pickup_date', value: '2026-07-15' },
            { key: 'pickup_time', value: '08:30' },
            { key: 'pickup_name', value: 'Amsterdam Timber Logistics B.V.' },
            { key: 'pickup_address', value: 'Herengracht 182' },
            { key: 'pickup_zipcode', value: '1016 BR' },
            { key: 'pickup_city', value: 'Amsterdam' },
            { key: 'pickup_country', value: 'NL' },
            { key: 'delivery_reference', value: 'DL-2026-1507' },
            { key: 'delivery_date', value: '2026-07-16' },
            { key: 'delivery_time', value: '10:00' },
            { key: 'delivery_name', value: 'Holzbau Nord GmbH' },
            {
              key: 'delivery_address',
              value: 'Industriestra\u00C3\u0178e 45',
            },
            { key: 'delivery_zipcode', value: '28195' },
            { key: 'delivery_city', value: 'Bremen' },
            { key: 'delivery_country', value: 'DE' },
            { key: 'cargo_unit_amount', value: '8' },
            { key: 'cargo_unit_id', value: 'pallet' },
            { key: 'cargo_weight', value: '18500' },
            { key: 'length', value: '1200' },
            { key: 'width', value: '240' },
            { key: 'height', value: '320' },
            { key: 'cargo_loading_meter', value: '96000' },
            { key: 'cargo_volume', value: '737280' },
            { key: 'goods_loading_meter', value: '96000' },
            { key: 'goods_volume', value: '737280' },
          ],
          emailMessage: {
            subject: 'Transportopdracht',
            attachments: [],
          },
        }),
      },
      orderField: {
        upsert: jest.fn().mockResolvedValue(null),
      },
      xmlDelivery: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(null),
      },
    } as any;

    const service = new XmlService(prisma, {} as any);

    const xml = await service.generateOrderXml('order-1');

    expect(xml).toContain('<address1>Industriestraße 45</address1>');
    expect(xml).toContain('<loadingmeter>96.000</loadingmeter>');
    expect(xml).toContain('<volume>737.280</volume>');

    expect(prisma.orderField.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId_key: { orderId: 'order-1', key: 'cargo_loading_meter' },
        },
        update: expect.objectContaining({ value: '96.000' }),
      }),
    );
    expect(prisma.orderField.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId_key: { orderId: 'order-1', key: 'cargo_volume' } },
        update: expect.objectContaining({ value: '737.280' }),
      }),
    );
  });
});
