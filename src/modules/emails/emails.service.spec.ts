import { NotFoundException } from '@nestjs/common';
import { EmailsService } from './emails.service';

describe('EmailsService', () => {
  it('returns linkedOrder when the email is a reply without a primary order relation', async () => {
    const prismaService: any = {
      emailMessage: {
        findUnique: jest.fn(async () => ({
          id: 'email-1',
          graphMessageId: 'graph-1',
          conversationId: 'conversation-1',
          fromEmail: 'customer@example.com',
          fromName: 'Customer',
          subject: 'RE: Missing Transport Order Information',
          bodyText: 'Reply body',
          bodyHtml: null,
          receivedAt: new Date('2026-06-08T12:00:00Z'),
          hasAttachments: false,
          status: 'PROCESSED',
          mailbox: {
            id: 'mailbox-1',
            email: 'ops@example.com',
            department: 'OPEN_TRANSPORT',
            active: true,
            lastSyncedAt: null,
          },
          attachments: [],
          orders: [],
          linkedOrder: {
            id: 'order-1',
            status: 'WAITING_CUSTOMER_RESPONSE',
            department: 'OPEN_TRANSPORT',
            type: 'NEW_ORDER',
            overallConfidence: 0.91,
            createdAt: new Date('2026-06-08T10:00:00Z'),
            updatedAt: new Date('2026-06-08T12:10:00Z'),
          },
        })),
      },
    };

    const service = new EmailsService(prismaService);

    const result = await service.findOne('email-1');

    expect(result.order).toMatchObject({
      id: 'order-1',
      status: 'WAITING_CUSTOMER_RESPONSE',
      department: 'OPEN_TRANSPORT',
      type: 'NEW_ORDER',
      overallConfidence: 0.91,
    });
  });

  it('throws when the email does not exist', async () => {
    const prismaService: any = {
      emailMessage: {
        findUnique: jest.fn(async () => null),
      },
    };

    const service = new EmailsService(prismaService);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deletes only the reply email when there is no primary order relation', async () => {
    const emailDelete = jest.fn(async () => ({}));

    const prismaService: any = {
      emailMessage: {
        findUnique: jest.fn(async () => ({
          id: 'reply-1',
          orders: [],
        })),
        delete: emailDelete,
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          emailMessage: {
            delete: emailDelete,
          },
        }),
      ),
    };

    const service = new EmailsService(prismaService);

    const result = await service.remove('reply-1');

    expect(emailDelete).toHaveBeenCalledWith({
      where: { id: 'reply-1' },
    });
    expect(result).toEqual({
      ok: true,
      deletedEmailId: 'reply-1',
      deletedOrderId: null,
      deletedReplyEmailsCount: 0,
    });
  });

  it('deletes the original email and linked replies when removing an order source email', async () => {
    const emailDelete = jest.fn(async () => ({}));
    const emailDeleteMany = jest.fn(async () => ({ count: 2 }));
    const emailFindMany = jest.fn(async () => [
      { id: 'reply-1' },
      { id: 'reply-2' },
    ]);

    const prismaService: any = {
      emailMessage: {
        findUnique: jest.fn(async () => ({
          id: 'email-1',
          orders: [{ id: 'order-1' }],
        })),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          emailMessage: {
            findMany: emailFindMany,
            deleteMany: emailDeleteMany,
            delete: emailDelete,
          },
        }),
      ),
    };

    const service = new EmailsService(prismaService);

    const result = await service.remove('email-1');

    expect(emailFindMany).toHaveBeenCalledWith({
      where: { linkedOrderId: { in: ['order-1'] }, id: { not: 'email-1' } },
      select: { id: true },
    });
    expect(emailDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['reply-1', 'reply-2'] },
      },
    });
    expect(emailDelete).toHaveBeenCalledWith({
      where: { id: 'email-1' },
    });
    expect(result).toEqual({
      ok: true,
      deletedEmailId: 'email-1',
      deletedOrderId: 'order-1',
      deletedReplyEmailsCount: 2,
    });
  });
});
