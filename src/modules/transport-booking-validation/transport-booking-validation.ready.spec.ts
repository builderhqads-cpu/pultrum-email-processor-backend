import { OrderStatus } from '@prisma/client';
import { TransportBookingValidationService } from './transport-booking-validation.service';

describe('TransportBookingValidationService (NL labeled email)', () => {
  const emailText = `
Laaddatum: 2026-06-01
Laadtijd: 10:00
Laadreferentie: 123456
Laadnaam: E3 Spedition-Transport A/S
Laadadres: Transitvej 16
Laadland: DK
Laadpostcode: 6330
Laadplaats: Padborg
Laad contact: John
Laad telefoonnummer: +4512345678
Laad e-mailadres: pickup@example.com

Losdatum: 2026-06-02
Lostijd: 12:00
Losreferentie: 789178
Losnaam: Systro Gastronomie GmbH
Losadres: Rodgaustraße 7
Losland: DE
Lospostcode: 63457
Losplaats: Hanau
Los contact: Maria
Los telefoonnummer: +4912345678
Los e-mailadres: delivery@example.com

Aantal: 5
Eenheid: colli
Product: 1109
Gewicht: 50
Lengte: 20
Breedte: 20
Hoogte: 90
Transportsoort: standaard
Factuurreferentie: 1234567890
Prijs: 250
`.trim();

  it('produces READY_TO_XML (time_till optional)', async () => {
    const transportOrderUpdate = jest.fn();
    const missingFieldDeleteMany = jest.fn();
    const missingFieldCreateMany = jest.fn();
    const orderFieldUpsert = jest.fn();
    const orderFieldDeleteMany = jest.fn();

    const prismaService: any = {
      transportOrder: {
        findUnique: jest.fn().mockResolvedValue({ id: 'order-1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'order-1' }),
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
          validationWarning: {
            deleteMany: jest.fn(async () => ({})),
            createMany: jest.fn(async () => ({})),
          },
          orderField: { upsert: orderFieldUpsert, deleteMany: orderFieldDeleteMany },
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
      // This test asserts the XML job IS enqueued for a complete order, so the
      // operation mode must allow auto-delivery.
      { shouldAutoDeliver: async () => true } as any,
    );

    const email: any = {
      id: 'email-1',
      subject: 'Subject not used',
      bodyText: null,
      bodyHtml: null,
    };

    const result = await service.validateEmailContent(email, emailText);

    expect(result.isComplete).toBe(true);
    expect(result.missingFields).toHaveLength(0);

    expect(transportOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.READY_TO_XML }),
      }),
    );

    expect(aiRequestQueue.add).not.toHaveBeenCalled();
    expect(xmlDeliveryQueue.add).toHaveBeenCalled();
  });
});

