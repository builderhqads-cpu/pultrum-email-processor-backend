import { OrderStatus } from '@prisma/client';
import { TransportBookingValidationService } from './transport-booking-validation.service';

describe('TransportBookingValidationService.validateOrderFromFieldValues', () => {
  it('produces READY_TO_XML when all required email fields are present', async () => {
    const transportOrderUpdate = jest.fn();
    const missingFieldDeleteMany = jest.fn();
    const missingFieldCreateMany = jest.fn();
    const orderFieldUpsert = jest.fn();
    const orderFieldDeleteMany = jest.fn();

    const prismaService: any = {
      transportOrder: {
        update: transportOrderUpdate,
      },
      missingField: {
        deleteMany: missingFieldDeleteMany,
        createMany: missingFieldCreateMany,
      },
      orderField: {
        upsert: orderFieldUpsert,
        deleteMany: orderFieldDeleteMany,
      },
      $transaction: async (fn: any) =>
        await fn({
          transportOrder: { update: transportOrderUpdate },
          missingField: {
            deleteMany: missingFieldDeleteMany,
            createMany: missingFieldCreateMany,
          },
          orderField: {
            upsert: orderFieldUpsert,
            deleteMany: orderFieldDeleteMany,
          },
        }),
    };

    const configService: any = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const aiRequestQueue: any = { add: jest.fn() };
    const xmlDeliveryQueue: any = { add: jest.fn() };

    const service = new TransportBookingValidationService(
      prismaService,
      configService,
      aiRequestQueue,
      xmlDeliveryQueue,
      { shouldAutoDeliver: async () => false } as any,
    );

    const res = await service.validateOrderFromFieldValues(
      {
        orderId: 'order-1',
        emailMessageId: 'email-1',
        emailSubject: 'Invoice 123',
        source: 'ai',
        fieldValues: {
          pickup_date: '2026-06-01',
          pickup_time: '10:00',
          pickup_reference: '123456',
          pickup_name: 'E3 Spedition-Transport A/S',
          pickup_address: 'Transitvej 16',
          pickup_country: 'DK',
          pickup_zipcode: '6330',
          pickup_city: 'Padborg',
          pickup_contact: 'John',
          pickup_phone: '+4512345678',
          pickup_email: 'pickup@example.com',

          delivery_date: '2026-06-02',
          delivery_time: '12:00',
          delivery_reference: '789178',
          delivery_name: 'Systro Gastronomie GmbH',
          delivery_address: 'Rodgaustraße 7',
          delivery_country: 'DE',
          delivery_zipcode: '63457',
          delivery_city: 'Hanau',
          delivery_contact: 'Maria',
          delivery_phone: '+4912345678',
          delivery_email: 'delivery@example.com',

          unit_amount: '5',
          unit_id: 'colli',
          weight: '50',
          product_id: '1109',
          length: '20',
          width: '20',
          height: '90',
          invoice_reference: '1234567890',
        },
      },
      { enqueueJobs: true },
    );

    expect(res.isComplete).toBe(true);
    expect(res.missingFields).toHaveLength(0);

    expect(transportOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: OrderStatus.READY_TO_XML }),
      }),
    );

    expect(aiRequestQueue.add).not.toHaveBeenCalled();
    expect(xmlDeliveryQueue.add).toHaveBeenCalled();
  });

  it('persists per-field source and confidence metadata when provided', async () => {
    const transportOrderUpdate = jest.fn();
    const missingFieldDeleteMany = jest.fn();
    const missingFieldCreateMany = jest.fn();
    const orderFieldUpsert = jest.fn();
    const orderFieldDeleteMany = jest.fn();

    const prismaService: any = {
      transportOrder: {
        update: transportOrderUpdate,
      },
      missingField: {
        deleteMany: missingFieldDeleteMany,
        createMany: missingFieldCreateMany,
      },
      orderField: {
        upsert: orderFieldUpsert,
        deleteMany: orderFieldDeleteMany,
      },
      $transaction: async (fn: any) =>
        await fn({
          transportOrder: { update: transportOrderUpdate },
          missingField: {
            deleteMany: missingFieldDeleteMany,
            createMany: missingFieldCreateMany,
          },
          orderField: {
            upsert: orderFieldUpsert,
            deleteMany: orderFieldDeleteMany,
          },
        }),
    };

    const configService: any = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const aiRequestQueue: any = { add: jest.fn() };
    const xmlDeliveryQueue: any = { add: jest.fn() };

    const service = new TransportBookingValidationService(
      prismaService,
      configService,
      aiRequestQueue,
      xmlDeliveryQueue,
      { shouldAutoDeliver: async () => false } as any,
    );

    await service.validateOrderFromFieldValues(
      {
        orderId: 'order-1',
        emailMessageId: 'email-1',
        emailSubject: 'Reply',
        source: 'email',
        fieldValues: {
          pickup_date: '2026-06-01',
          delivery_city: 'Hanau',
        },
        fieldMetaByKey: {
          pickup_date: { confidence: 0.95, source: 'EMAIL' as any },
          delivery_city: { confidence: 0.85, source: 'AI' as any },
        },
      },
      { enqueueJobs: false },
    );

    expect(orderFieldUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId_key: { orderId: 'order-1', key: 'pickup_date' } },
        create: expect.objectContaining({
          source: 'EMAIL',
          confidence: 0.95,
        }),
      }),
    );
    expect(orderFieldUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId_key: { orderId: 'order-1', key: 'delivery_city' } },
        create: expect.objectContaining({
          source: 'AI',
          confidence: 0.85,
        }),
      }),
    );
  });
});
