import { OrderStatus } from '@prisma/client';
import { TransportBookingValidationService } from './transport-booking-validation.service';

describe('TransportBookingValidationService (reply variants)', () => {
  it('clears delivery_zipcode and delivery_country from reply labels', async () => {
    const transportOrderUpdate = jest.fn(async () => ({}));
    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn(async () => ({ id: 'order-1' })),
        findFirst: jest.fn(async () => ({ id: 'order-1' })),
        update: transportOrderUpdate,
      },
      missingField: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async () => ({})) },
      validationWarning: {
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({})),
      },
      orderField: { upsert: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => fn(prismaService)),
    };

    const configService: any = { get: jest.fn().mockReturnValue(undefined) };
    const aiRequestQueue: any = { add: jest.fn() };
    const xmlDeliveryQueue: any = { add: jest.fn() };

    const service = new TransportBookingValidationService(
      prismaService,
      configService,
      aiRequestQueue,
      xmlDeliveryQueue,
      { shouldAutoDeliver: async () => false } as any,
    );

    const email: any = {
      id: 'email-1',
      subject: 'RE: ... [PULTRUM-717b66b9]',
      bodyText: '> Postcode afleveradres: 63457\r> Land afleveradres: Duitsland (DE)\r',
      bodyHtml: null,
    };

    const result = await service.validateEmailContent(email, undefined, { enqueueJobs: false });
    expect(result.missingFields.find((m) => m.key === 'delivery_zipcode')).toBeFalsy();
    expect(result.missingFields.find((m) => m.key === 'delivery_country')).toBeFalsy();

    // Not asserting full completeness here; just that those fields are detected and order gets updated.
    expect(transportOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: expect.any(String) }),
      }),
    );
  });
});
