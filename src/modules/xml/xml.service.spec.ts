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
    // TPE Standard: <documenttype_id matchmode="0">, <filedata>, <concerns>.
    // 19 = EMAIL (.eml), 92 = EMAIL Attachment.
    expect(xml).toContain('<documenttype_id matchmode="0">19</documenttype_id>');
    expect(xml).toContain('<filename>Transport Request 003.eml</filename>');
    expect(xml).toContain('<filedata>ZW1sLWNvbnRlbnQ=</filedata>');
    expect(xml).toContain('<concerns>E-mail</concerns>');

    // Attachments carry document-type code 92, base64 in <filedata>.
    expect(xml).toContain('<documenttype_id matchmode="0">92</documenttype_id>');
    expect(xml).toContain('<filename>order.pdf</filename>');
    expect(xml).toContain('<filedata>cGRmLWNvbnRlbnQ=</filedata>');
    expect(xml).toContain('<concerns>Bijlage</concerns>');

    expect(xml).toContain('<filename>rates.xlsx</filename>');
    expect(xml).toContain('<filedata>eGxzeC1jb250ZW50</filedata>');

    // A real image attachment (e.g. an access route) is now packaged too.
    expect(xml).toContain('<filename>access-route.jpg</filename>');

    // The old (wrong) element names must be gone.
    expect(xml).not.toContain('<mimetype>');
    expect(xml).not.toContain('<contentbase64>');
    expect(xml).not.toContain('<documenttype>');

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
            { key: 'transport_type', value: 'Platte X-Lam' },
            { key: 'pickup_reference', value: 'PU-2026-1507' },
            { key: 'pickup_date', value: '2026-07-15' },
            { key: 'pickup_date_till', value: '2026-07-16' },
            { key: 'pickup_time', value: '08:30' },
            { key: 'pickup_name', value: 'Amsterdam Timber Logistics B.V.' },
            { key: 'pickup_address', value: 'Herengracht 182' },
            { key: 'pickup_zipcode', value: '1016 BR' },
            { key: 'pickup_city', value: 'Amsterdam' },
            { key: 'pickup_country', value: 'NL' },
            { key: 'pickup_contact', value: 'Nils Mindrup' },
            { key: 'pickup_phone', value: '00495456930356' },
            { key: 'pickup_email', value: 'transporte.wk@derix.de' },
            { key: 'delivery_contact', value: 'Jan Jansen' },
            { key: 'delivery_phone', value: '0612345678' },
            { key: 'delivery_email', value: 'ontvangst@klant.nl' },
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
            { key: 'pickup_remarks', value: 'Poort 3' },
            { key: 'driver_pickup_info', value: 'Altijd lieferschein meenemen!' },
            { key: 'driver_delivery_info', value: 'Foto van pakbon maken' },
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
    expect(xml).toContain('<datetill>2026-07-16</datetill>');
    expect(xml).toContain('<loadingmeter>96.000</loadingmeter>');
    expect(xml).toContain('<volume>737.280</volume>');
    // Both cargo AND goodsline unit_id carry matchmode="1" (Creative Gears):
    // no bare <unit_id> without the attribute.
    expect(xml).toContain('<unit_id matchmode="1">pallet</unit_id>');
    expect(xml).not.toMatch(/<unit_id>/);
    // Driver info goes to the dedicated <driverinfo> field (Transpas), and the
    // address <remarks> keeps ONLY the address remark.
    expect(xml).toContain('<remarks>Poort 3</remarks>');
    expect(xml).toContain(
      '<driverinfo>Altijd lieferschein meenemen!</driverinfo>',
    );
    expect(xml).toContain('<driverinfo>Foto van pakbon maken</driverinfo>');
    // Rick's mapping corrections (2026-08-06):
    // invoice reference -> shipment/reference
    expect(xml).toMatch(
      /<shipment>[\s\S]*<reference>INV-2026-1507<\/reference>/,
    );
    // transport type -> coded transportkind_id
    expect(xml).toContain(
      '<transportkind_id matchmode="1">Platte X-Lam</transportkind_id>',
    );
    // pickup + delivery contact/phone/email
    expect(xml).toContain('<contact>Nils Mindrup</contact>');
    expect(xml).toContain('<phone>00495456930356</phone>');
    expect(xml).toContain('<email>transporte.wk@derix.de</email>');
    expect(xml).toContain('<contact>Jan Jansen</contact>');
    expect(xml).toContain('<email>ontvangst@klant.nl</email>');
    // length also at cargo level
    expect(xml).toMatch(/<cargo>[\s\S]*<length>1200<\/length>/);
    // ediprovider_id defaults to 98 (Pultrum), matchmode 0, under <import>.
    expect(xml).toContain('<ediprovider_id matchmode="0">98</ediprovider_id>');
    // The provider sits between <import> and <transportbookings>, not inside a
    // transportbooking (Creative Gears spec).
    expect(xml).toMatch(
      /<import>\s*<ediprovider_id matchmode="0">98<\/ediprovider_id>\s*<transportbookings>/,
    );

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

  it('omits the <documents> block when CREATIVE_GEARS_INCLUDE_DOCUMENTS=false', async () => {
    const prev = process.env.CREATIVE_GEARS_INCLUDE_DOCUMENTS;
    process.env.CREATIVE_GEARS_INCLUDE_DOCUMENTS = 'false';
    try {
      const prisma = {
        transportOrder: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'order-3',
            status: 'READY_TO_XML',
            department: 'OPEN_TRANSPORT',
            customerEmail: 'customer@example.com',
            missingFields: [],
            fields: [
              { key: 'invoice_reference', value: 'INV-2026-1' },
              { key: 'pickup_date', value: '2026-07-15' },
              { key: 'pickup_address', value: 'Herengracht 182' },
              { key: 'pickup_zipcode', value: '1016 BR' },
              { key: 'pickup_city', value: 'Amsterdam' },
              { key: 'pickup_country', value: 'NL' },
              { key: 'delivery_date', value: '2026-07-16' },
              { key: 'delivery_address', value: 'Klosterstrasse 32' },
              { key: 'delivery_zipcode', value: '4780' },
              { key: 'delivery_city', value: 'St. Vith' },
              { key: 'delivery_country', value: 'BE' },
              { key: 'cargo_unit_amount', value: '1' },
              { key: 'cargo_unit_id', value: 'vracht' },
            ],
            emailMessage: {
              subject: 'KW31',
              rawMimeBase64: 'ZW1sLWNvbnRlbnQ=',
              rawMimeFileName: 'KW31.eml',
              rawMimeMimeType: 'message/rfc822',
              attachments: [
                {
                  fileName: 'order.pdf',
                  mimeType: 'application/pdf',
                  contentBase64: 'cGRmLWNvbnRlbnQ=',
                },
              ],
            },
          }),
        },
        orderField: { upsert: jest.fn().mockResolvedValue(null) },
        xmlDelivery: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(null),
        },
      } as any;

      const service = new XmlService(prisma, {} as any);

      const xml = await service.generateOrderXml('order-3');

      expect(xml).not.toContain('<documents>');
      expect(xml).not.toContain('contentbase64');
    } finally {
      if (prev === undefined)
        delete process.env.CREATIVE_GEARS_INCLUDE_DOCUMENTS;
      else process.env.CREATIVE_GEARS_INCLUDE_DOCUMENTS = prev;
    }
  });

  it('keeps the deellading volume (does not recompute it from full dimensions)', async () => {
    const prisma = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-dl',
          status: 'READY_TO_XML',
          department: 'OPEN_TRANSPORT',
          customerEmail: 'customer@example.com',
          missingFields: [],
          fields: [
            { key: 'invoice_reference', value: 'INV-1' },
            { key: 'pickup_date', value: '2026-07-06' },
            { key: 'pickup_address', value: 'Industriestrasse 24' },
            { key: 'pickup_zipcode', value: '49492' },
            { key: 'pickup_city', value: 'Westerkappeln' },
            { key: 'pickup_country', value: 'DE' },
            { key: 'delivery_date', value: '2026-07-07' },
            { key: 'delivery_address', value: 'Schlutterweg 68' },
            { key: 'delivery_zipcode', value: '27755' },
            { key: 'delivery_city', value: 'Delmenhorst' },
            { key: 'delivery_country', value: 'DE' },
            { key: 'cargo_unit_amount', value: '1' },
            { key: 'cargo_unit_id', value: 'deellading' },
            { key: 'cargo_weight', value: '1574' },
            // Per-shipment volume (17.134 / 5), NOT derivable from the full dims.
            { key: 'cargo_volume', value: '3.43' },
            // Full (shared) dimensions incl. a height that WOULD recompute volume.
            { key: 'length', value: '1200' },
            { key: 'width', value: '250' },
            { key: 'height', value: '100' },
          ],
          emailMessage: { subject: 'KW28', attachments: [] },
        }),
      },
      orderField: { upsert: jest.fn().mockResolvedValue(null) },
      xmlDelivery: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(null),
      },
    } as any;

    const service = new XmlService(prisma, {} as any);
    const xml = await service.generateOrderXml('order-dl');

    // The divided volume survives; it is NOT overwritten by length*width*height.
    expect(xml).toContain('<volume>3.43</volume>');
    expect(xml).not.toContain('<volume>30'); // 1.2*2.5*1.0 = 3.0 m3 would be wrong
    expect(
      prisma.orderField.upsert.mock.calls.some(
        (c: any[]) => c[0]?.where?.orderId_key?.key === 'cargo_volume',
      ),
    ).toBe(false); // no recompute persisted for deellading
  });

  it('emits customer_id from the fields and honours CREATIVE_GEARS_EDI_PROVIDER', async () => {
    const prev = process.env.CREATIVE_GEARS_EDI_PROVIDER;
    process.env.CREATIVE_GEARS_EDI_PROVIDER = '77';
    try {
      const prisma = {
        transportOrder: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'order-4',
            status: 'READY_TO_XML',
            department: 'OPEN_TRANSPORT',
            customerEmail: 'customer@example.com',
            missingFields: [],
            fields: [
              { key: 'customer_id', value: '12345' },
              { key: 'invoice_reference', value: 'INV-2026-1' },
              { key: 'pickup_date', value: '2026-07-15' },
              { key: 'pickup_address', value: 'Herengracht 182' },
              { key: 'pickup_zipcode', value: '1016 BR' },
              { key: 'pickup_city', value: 'Amsterdam' },
              { key: 'pickup_country', value: 'NL' },
              { key: 'delivery_date', value: '2026-07-16' },
              { key: 'delivery_address', value: 'Klosterstrasse 32' },
              { key: 'delivery_zipcode', value: '4780' },
              { key: 'delivery_city', value: 'St. Vith' },
              { key: 'delivery_country', value: 'BE' },
              { key: 'cargo_unit_amount', value: '1' },
              { key: 'cargo_unit_id', value: 'vracht' },
            ],
            emailMessage: { subject: 'KW31', attachments: [] },
          }),
        },
        orderField: { upsert: jest.fn().mockResolvedValue(null) },
        xmlDelivery: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(null),
        },
      } as any;

      const service = new XmlService(prisma, {} as any);
      const xml = await service.generateOrderXml('order-4');

      expect(xml).toContain('<customer_id matchmode="1">12345</customer_id>');
      expect(xml).toContain('<ediprovider_id matchmode="0">77</ediprovider_id>');
    } finally {
      if (prev === undefined) delete process.env.CREATIVE_GEARS_EDI_PROVIDER;
      else process.env.CREATIVE_GEARS_EDI_PROVIDER = prev;
    }
  });
});
