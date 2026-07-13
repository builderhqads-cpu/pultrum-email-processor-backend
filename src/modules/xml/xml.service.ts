import { Injectable } from '@nestjs/common';
import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces';
import {
  FieldRequirement,
  OrderStatus,
  XmlDeliveryStatus,
} from '@prisma/client';
import { OrderFieldSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TransportBookingValidationService } from '../transport-booking-validation/transport-booking-validation.service';
import {
  getRuleRequirement,
  TRANSPORT_BOOKING_FIELD_RULES,
} from '../required-fields/transport-booking-field-rules';
import {
  fixCommonMojibake,
  sanitizeExtractedValue,
} from '../../utils/sanitize';
import {
  blankIfZero,
  blankIfZeroPreservingDecimalString,
  dropNameIfCity,
  normalizeQuantity,
  parseDecimal,
} from '../../utils/field-normalize';

@Injectable()
export class XmlService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transportBookingValidationService: TransportBookingValidationService,
  ) {}

  private generateEdiReference() {
    // Short, unique-enough reference for EDI usage.
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `EDI-${ts}${rnd}`;
  }

  private parseNumber(value: string | null | undefined) {
    return parseDecimal(value);
  }

  private getFieldValue(map: Map<string, string>, key: string): string {
    return fixCommonMojibake(
      sanitizeExtractedValue((map.get(key) ?? '').toString()),
    );
  }

  private formatCalculatedValue(value: number | null) {
    return value == null || !Number.isFinite(value) ? '' : value.toFixed(3);
  }

  private calcVolume(params: {
    length: string;
    width: string;
    height: string;
    unitAmount: string;
  }) {
    const length = this.parseNumber(params.length);
    const width = this.parseNumber(params.width);
    const height = this.parseNumber(params.height);
    const unitAmount = this.parseNumber(params.unitAmount);

    if (
      length == null ||
      width == null ||
      height == null ||
      unitAmount == null
    ) {
      return null;
    }

    // Simple heuristic: treat values > 10 as centimeters, otherwise meters.
    const toMeters = (v: number) => (v > 10 ? v / 100 : v);

    const l = toMeters(length);
    const w = toMeters(width);
    const h = toMeters(height);

    const volume = l * w * h * unitAmount;
    return Number.isFinite(volume) ? volume : null;
  }

  private calcLoadingMeterCm(params: {
    length: string;
    width: string;
    unitAmount: string;
  }) {
    const length = this.parseNumber(params.length);
    const width = this.parseNumber(params.width);
    const unitAmount = this.parseNumber(params.unitAmount);
    if (length == null || width == null || unitAmount == null) return null;

    // Rule requested: (length * width * unit_amount) / 24000, considering cm.
    const ldm = (length * width * unitAmount) / 24000;
    return Number.isFinite(ldm) ? ldm : null;
  }

  private ruleLabelByKey(key: string) {
    return (
      TRANSPORT_BOOKING_FIELD_RULES.find((r) => r.key === key)?.label ?? key
    );
  }

  private normalizeDocumentFileName(
    value: string | null | undefined,
    fallback: string,
  ) {
    const sanitizedControlChars = (value || '')
      .split('')
      .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
      .join('');

    const normalized = sanitizedControlChars
      .trim()
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ');

    return fixCommonMojibake(normalized || fallback);
  }

  private isSupportedOriginalAttachment(input: {
    fileName?: string | null;
    mimeType?: string | null;
    contentBase64?: string | null;
  }) {
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
      // Real image attachments (e.g. an access-route / aanrijroute photo).
      // Inline logo/signature images are already filtered out upstream.
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

  private appendOriginalDocuments(
    shipmentNode: XMLBuilder,
    emailMessage:
      | {
          id: string;
          subject?: string | null;
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
  ) {
    if (!emailMessage) return;
    const documentEntries: Array<{
      documentType: string;
      fileName: string;
      mimeType: string;
      contentBase64: string;
    }> = [];

    if (emailMessage.rawMimeBase64?.trim()) {
      documentEntries.push({
        documentType: 'email-original',
        fileName: this.normalizeDocumentFileName(
          emailMessage.rawMimeFileName,
          'original-email.eml',
        ),
        mimeType: emailMessage.rawMimeMimeType?.trim() || 'message/rfc822',
        contentBase64: emailMessage.rawMimeBase64.trim(),
      });
    }

    for (const attachment of emailMessage.attachments ?? []) {
      if (!this.isSupportedOriginalAttachment(attachment)) continue;

      documentEntries.push({
        documentType: 'attachment',
        fileName: this.normalizeDocumentFileName(
          attachment.fileName,
          `attachment-${documentEntries.length + 1}`,
        ),
        mimeType: (attachment.mimeType || 'application/octet-stream').trim(),
        contentBase64: (attachment.contentBase64 || '').trim(),
      });
    }

    if (documentEntries.length === 0) return;

    const documents = shipmentNode.ele('documents');
    for (const entry of documentEntries) {
      documents
        .ele('document')
        .ele('documenttype')
        .txt(entry.documentType)
        .up()
        .ele('filename')
        .txt(entry.fileName)
        .up()
        .ele('mimetype')
        .txt(entry.mimeType)
        .up()
        .ele('contentbase64')
        .txt(entry.contentBase64)
        .up()
        .up();
    }
    documents.up();
  }

  private async upsertOrderField(params: {
    orderId: string;
    key: string;
    value: string;
  }) {
    const label = this.ruleLabelByKey(params.key);
    const rule = TRANSPORT_BOOKING_FIELD_RULES.find(
      (r) => r.key === params.key,
    );
    const source =
      rule?.generated === true
        ? OrderFieldSource.GENERATED
        : rule?.calculable === true
          ? OrderFieldSource.CALCULATED
          : OrderFieldSource.EMAIL;
    const requirement = rule
      ? getRuleRequirement(rule)
      : FieldRequirement.OPTIONAL;
    await this.prismaService.orderField.upsert({
      where: { orderId_key: { orderId: params.orderId, key: params.key } },
      create: {
        orderId: params.orderId,
        key: params.key,
        label,
        value: params.value,
        source,
        required: requirement === FieldRequirement.REQUIRED,
        requirement,
        missing: false,
        confidence: null,
      },
      update: {
        label,
        value: params.value,
        source,
        required: requirement === FieldRequirement.REQUIRED,
        requirement,
        missing: false,
        confidence: null,
      },
    });
  }

  private assertRequiredNonEmpty(values: Record<string, string>) {
    const requiredKeys = TRANSPORT_BOOKING_FIELD_RULES.filter(
      (r) => getRuleRequirement(r) === FieldRequirement.REQUIRED,
    ).map((r) => r.key);

    const missing = requiredKeys.filter(
      (k) => !sanitizeExtractedValue(values[k] ?? ''),
    );

    if (missing.length) {
      throw new Error(
        `Cannot generate XML. Required fields are empty: ${missing.join(', ')}`,
      );
    }
  }

  private assertNoUnsafeHtml(xmlPayload: string) {
    const patterns = [
      /<\s*br\b/i,
      /&lt;\s*br\b/i,
      /<\/\s*div\b/i,
      /&lt;\/\s*div\b/i,
      /<\s*p\b/i,
      /&lt;\s*p\b/i,
    ];

    if (patterns.some((p) => p.test(xmlPayload))) {
      throw new Error(
        'XML contains unsafe HTML fragments. Sanitize extracted fields before generating XML.',
      );
    }
  }

  async generateOrderXml(orderId: string): Promise<string> {
    const retryableStatuses = new Set<OrderStatus>([
      OrderStatus.READY_TO_XML,
      OrderStatus.CREATIVE_GEARS_REJECTED,
      OrderStatus.FAILED,
    ]);

    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        fields: true,
        missingFields: true,
        emailMessage: {
          include: {
            attachments: {
              select: {
                fileName: true,
                mimeType: true,
                contentBase64: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new Error(`TransportOrder not found: id=${orderId}`);
    }

    if (!retryableStatuses.has(order.status)) {
      throw new Error(
        `Cannot generate XML for orderId=${orderId}. Order status must be READY_TO_XML or retryable after XML delivery failure/rejection (current=${order.status}).`,
      );
    }

    // Safety: even after validation, never generate when missing fields exist.
    if (order.missingFields?.length) {
      const keys = order.missingFields.map((m) => m.key).join(', ');
      throw new Error(
        `Cannot generate XML for orderId=${orderId}. Missing fields in DB: ${keys}`,
      );
    }

    const fieldMap = new Map<string, string>(
      order.fields.map((f) => [f.key, f.value ?? '']),
    );

    // Generated fields (persist if missing).
    let edireference = this.getFieldValue(fieldMap, 'edireference');
    if (!edireference) {
      edireference = this.generateEdiReference();
      await this.upsertOrderField({
        orderId: order.id,
        key: 'edireference',
        value: edireference,
      });
      fieldMap.set('edireference', edireference);
    }

    let shipmentEdiReference = this.getFieldValue(
      fieldMap,
      'shipment_edireference',
    );
    if (!shipmentEdiReference) {
      shipmentEdiReference = edireference;
      await this.upsertOrderField({
        orderId: order.id,
        key: 'shipment_edireference',
        value: shipmentEdiReference,
      });
      fieldMap.set('shipment_edireference', shipmentEdiReference);
    }

    // Barcode is never auto-generated: only an explicitly provided value is
    // emitted, otherwise the element goes out blank.
    const barcode = this.getFieldValue(fieldMap, 'barcode');

    // Calculated fields (persist when we can compute them).
    const unitAmount = this.getFieldValue(fieldMap, 'cargo_unit_amount');
    const unitId = this.getFieldValue(fieldMap, 'cargo_unit_id');
    const productId = this.getFieldValue(fieldMap, 'product_id');
    const weight = this.getFieldValue(fieldMap, 'cargo_weight');

    const length = this.getFieldValue(fieldMap, 'length');
    const width = this.getFieldValue(fieldMap, 'width');
    const height = this.getFieldValue(fieldMap, 'height');

    const computedCargoVolume = this.formatCalculatedValue(
      this.calcVolume({ length, width, height, unitAmount }),
    );
    let cargoVolume =
      computedCargoVolume || this.getFieldValue(fieldMap, 'cargo_volume');
    if (computedCargoVolume && cargoVolume !== this.getFieldValue(fieldMap, 'cargo_volume')) {
      await this.upsertOrderField({
        orderId: order.id,
        key: 'cargo_volume',
        value: computedCargoVolume,
      });
      fieldMap.set('cargo_volume', computedCargoVolume);
    }

    const computedCargoLoadingMeter = this.formatCalculatedValue(
      this.calcLoadingMeterCm({ length, width, unitAmount }),
    );
    let cargoLoadingMeter =
      computedCargoLoadingMeter ||
      this.getFieldValue(fieldMap, 'cargo_loading_meter');
    if (
      computedCargoLoadingMeter &&
      cargoLoadingMeter !== this.getFieldValue(fieldMap, 'cargo_loading_meter')
    ) {
      await this.upsertOrderField({
        orderId: order.id,
        key: 'cargo_loading_meter',
        value: computedCargoLoadingMeter,
      });
      fieldMap.set('cargo_loading_meter', computedCargoLoadingMeter);
    } else if (!cargoLoadingMeter || cargoLoadingMeter === '0') {
      // Not computable -> leave BLANK (never "0").
      cargoLoadingMeter = '';
    }

    const existingGoodsVolume = this.getFieldValue(fieldMap, 'goods_volume');
    let goodsVolume = cargoVolume || existingGoodsVolume;
    if (goodsVolume && goodsVolume !== existingGoodsVolume) {
      await this.upsertOrderField({
        orderId: order.id,
        key: 'goods_volume',
        value: goodsVolume,
      });
      fieldMap.set('goods_volume', goodsVolume);
    }

    const existingGoodsLoadingMeter = this.getFieldValue(
      fieldMap,
      'goods_loading_meter',
    );
    let goodsLoadingMeter = cargoLoadingMeter || existingGoodsLoadingMeter;
    if (goodsLoadingMeter && goodsLoadingMeter !== existingGoodsLoadingMeter) {
      await this.upsertOrderField({
        orderId: order.id,
        key: 'goods_loading_meter',
        value: goodsLoadingMeter,
      });
      fieldMap.set('goods_loading_meter', goodsLoadingMeter);
    }

    let bookingReference = this.getFieldValue(fieldMap, 'reference');
    if (!bookingReference) {
      bookingReference =
        this.getFieldValue(fieldMap, 'invoice_reference') ||
        sanitizeExtractedValue(order.emailMessage?.subject ?? '');
      if (bookingReference) {
        await this.upsertOrderField({
          orderId: order.id,
          key: 'reference',
          value: bookingReference,
        });
        fieldMap.set('reference', bookingReference);
      }
    }
    const customerId = this.getFieldValue(fieldMap, 'customer_id');
    const pickupRef = this.getFieldValue(fieldMap, 'pickup_reference');
    const deliveryRef = this.getFieldValue(fieldMap, 'delivery_reference');

    let shipmentReference = this.getFieldValue(fieldMap, 'shipment_reference');
    if (!shipmentReference) {
      shipmentReference = deliveryRef || pickupRef;
      if (shipmentReference) {
        await this.upsertOrderField({
          orderId: order.id,
          key: 'shipment_reference',
          value: shipmentReference,
        });
        fieldMap.set('shipment_reference', shipmentReference);
      }
    }

    let externalShipmentId = this.getFieldValue(
      fieldMap,
      'external_shipment_id',
    );
    if (!externalShipmentId) {
      externalShipmentId =
        this.getFieldValue(fieldMap, 'invoice_reference') || bookingReference;
      if (externalShipmentId) {
        await this.upsertOrderField({
          orderId: order.id,
          key: 'external_shipment_id',
          value: externalShipmentId,
        });
        fieldMap.set('external_shipment_id', externalShipmentId);
      }
    }

    // Derive goods fields from cargo when missing.
    let goodsUnitAmount = this.getFieldValue(fieldMap, 'goods_unit_amount');
    if (!goodsUnitAmount && unitAmount) {
      goodsUnitAmount = unitAmount;
      await this.upsertOrderField({
        orderId: order.id,
        key: 'goods_unit_amount',
        value: goodsUnitAmount,
      });
      fieldMap.set('goods_unit_amount', goodsUnitAmount);
    }

    let goodsUnitId = this.getFieldValue(fieldMap, 'goods_unit_id');
    if (!goodsUnitId && unitId) {
      goodsUnitId = unitId;
      await this.upsertOrderField({
        orderId: order.id,
        key: 'goods_unit_id',
        value: goodsUnitId,
      });
      fieldMap.set('goods_unit_id', goodsUnitId);
    }

    let goodsWeight = this.getFieldValue(fieldMap, 'goods_weight');
    if (!goodsWeight && weight) {
      goodsWeight = weight;
      await this.upsertOrderField({
        orderId: order.id,
        key: 'goods_weight',
        value: goodsWeight,
      });
      fieldMap.set('goods_weight', goodsWeight);
    }

    const pickupRemarks = this.getFieldValue(fieldMap, 'pickup_remarks');
    const deliveryRemarks = this.getFieldValue(fieldMap, 'delivery_remarks');

    const pickupTimeTill = this.getFieldValue(fieldMap, 'pickup_time_till');
    const deliveryTimeTill = this.getFieldValue(fieldMap, 'delivery_time_till');

    const valuesForValidation = Object.fromEntries(
      Array.from(fieldMap.entries()).map(([key, value]) => [
        key,
        sanitizeExtractedValue(value ?? ''),
      ]),
    );

    valuesForValidation.edireference = edireference;
    valuesForValidation.reference = bookingReference;
    valuesForValidation.shipment_edireference = shipmentEdiReference;
    valuesForValidation.shipment_reference = shipmentReference;
    valuesForValidation.external_shipment_id = externalShipmentId;
    valuesForValidation.barcode = barcode;
    valuesForValidation.cargo_unit_amount = unitAmount;
    valuesForValidation.cargo_unit_id = unitId;
    valuesForValidation.cargo_weight = weight;
    valuesForValidation.cargo_loading_meter = cargoLoadingMeter;
    valuesForValidation.cargo_volume = cargoVolume;
    valuesForValidation.goods_unit_amount = goodsUnitAmount;
    valuesForValidation.goods_unit_id = goodsUnitId;
    valuesForValidation.product_id = productId;
    valuesForValidation.goods_weight = goodsWeight;
    valuesForValidation.goods_loading_meter = goodsLoadingMeter;
    valuesForValidation.goods_volume = goodsVolume;
    valuesForValidation.length = length;
    valuesForValidation.width = width;
    valuesForValidation.height = height;

    // Final guard: block only when required Pultrum fields are still empty.
    this.assertRequiredNonEmpty(valuesForValidation);

    const doc = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('transportbookings')
      .ele('transportbooking')
      .ele('edireference')
      .txt(edireference)
      .up()
      .ele('reference')
      .txt(bookingReference)
      .up()
      .ele('customer_id', { matchmode: '1' })
      .txt(customerId)
      .up()
      .ele('shipments')
      .ele('shipment')
      .ele('edireference')
      .txt(shipmentEdiReference)
      .up()
      .ele('reference')
      .txt(shipmentReference)
      .up();

    // pickupaddress
    const pickup = doc.ele('pickupaddress');
    pickup.ele('reference').txt(pickupRef).up();
    pickup.ele('date').txt(this.getFieldValue(fieldMap, 'pickup_date')).up();
    pickup.ele('time').txt(this.getFieldValue(fieldMap, 'pickup_time')).up();
    pickup.ele('timetill').txt(pickupTimeTill).up();
    pickup
      .ele('name')
      .txt(
        dropNameIfCity(
          this.getFieldValue(fieldMap, 'pickup_name'),
          this.getFieldValue(fieldMap, 'pickup_city'),
        ),
      )
      .up();
    pickup
      .ele('address1')
      .txt(this.getFieldValue(fieldMap, 'pickup_address'))
      .up();
    pickup
      .ele('zipcode')
      .txt(this.getFieldValue(fieldMap, 'pickup_zipcode'))
      .up();
    pickup
      .ele('city_id', { matchmode: '4' })
      .txt(this.getFieldValue(fieldMap, 'pickup_city'))
      .up();
    pickup
      .ele('country_id', { matchmode: '2' })
      .txt(this.getFieldValue(fieldMap, 'pickup_country'))
      .up();
    pickup.ele('remarks').txt(pickupRemarks).up();
    pickup.up();

    // deliveryaddress
    const delivery = doc.ele('deliveryaddress');
    delivery.ele('reference').txt(deliveryRef).up();
    delivery
      .ele('date')
      .txt(this.getFieldValue(fieldMap, 'delivery_date'))
      .up();
    delivery
      .ele('time')
      .txt(this.getFieldValue(fieldMap, 'delivery_time'))
      .up();
    delivery.ele('timetill').txt(deliveryTimeTill).up();
    delivery
      .ele('name')
      .txt(
        dropNameIfCity(
          this.getFieldValue(fieldMap, 'delivery_name'),
          this.getFieldValue(fieldMap, 'delivery_city'),
        ),
      )
      .up();
    delivery
      .ele('address1')
      .txt(this.getFieldValue(fieldMap, 'delivery_address'))
      .up();
    delivery
      .ele('zipcode')
      .txt(this.getFieldValue(fieldMap, 'delivery_zipcode'))
      .up();
    delivery
      .ele('city_id', { matchmode: '4' })
      .txt(this.getFieldValue(fieldMap, 'delivery_city'))
      .up();
    delivery
      .ele('country_id', { matchmode: '2' })
      .txt(this.getFieldValue(fieldMap, 'delivery_country'))
      .up();
    delivery.ele('remarks').txt(deliveryRemarks).up();
    delivery.up();

    // cargo
    const cargo = doc.ele('cargo');
    cargo.ele('unitamount').txt(normalizeQuantity(unitAmount)).up();
    cargo.ele('unit_id').txt(unitId).up();
    cargo.ele('weight').txt(blankIfZero(weight)).up();
    cargo
      .ele('loadingmeter')
      .txt(blankIfZeroPreservingDecimalString(cargoLoadingMeter))
      .up();
    cargo
      .ele('volume')
      .txt(blankIfZeroPreservingDecimalString(cargoVolume))
      .up();
    cargo
      .ele('externalshipmentid')
      .txt(this.getFieldValue(fieldMap, 'external_shipment_id'))
      .up();
    cargo.ele('barcode').txt(barcode).up();
    cargo.ele('cmrnumber').txt(this.getFieldValue(fieldMap, 'cmr_number')).up();

    const goodslines = cargo.ele('goodslines').ele('goodsline');
    goodslines.ele('unitamount').txt(normalizeQuantity(goodsUnitAmount)).up();
    goodslines.ele('unit_id', { matchmode: '1' }).txt(goodsUnitId).up();
    goodslines.ele('product_id', { matchmode: '1' }).txt(productId).up();
    goodslines.ele('weight').txt(blankIfZero(goodsWeight)).up();
    goodslines
      .ele('loadingmeter')
      .txt(blankIfZeroPreservingDecimalString(goodsLoadingMeter))
      .up();
    goodslines
      .ele('volume')
      .txt(blankIfZeroPreservingDecimalString(goodsVolume))
      .up();
    goodslines.ele('length').txt(blankIfZero(length)).up();
    goodslines.ele('width').txt(blankIfZero(width)).up();
    goodslines.ele('height').txt(blankIfZero(height)).up();
    goodslines.up().up().up(); // goodsline -> goodslines -> cargo

    this.appendOriginalDocuments(doc, order.emailMessage);

    doc.up().up().up(); // shipment -> shipments -> transportbooking
    doc.up(); // transportbookings

    const xmlPayload = doc.end({ prettyPrint: true });

    this.assertNoUnsafeHtml(xmlPayload);

    const existingPending = await this.prismaService.xmlDelivery.findFirst({
      where: { orderId: order.id, status: XmlDeliveryStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending) {
      await this.prismaService.xmlDelivery.update({
        where: { id: existingPending.id },
        data: { xmlPayload },
      });
    } else {
      await this.prismaService.xmlDelivery.create({
        data: {
          orderId: order.id,
          xmlPayload,
          status: XmlDeliveryStatus.PENDING,
        },
      });
    }

    return xmlPayload;
  }
}
