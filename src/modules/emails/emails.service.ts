import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import {
  concernsForDocumentType,
  EMAIL_DOCUMENT_TYPE,
  isXmlDocumentAttachment,
  normalizeDocumentTypeRules,
  resolveAttachmentDocumentType,
  xmlDocumentsEnabled,
} from '../../utils/xml-documents';
import { QUEUE_EMAIL_PROCESSING } from '../queues/queue-names';
import { EmailOriginalService } from './email-original.service';

@Injectable()
export class EmailsService {
  constructor(
    private readonly prismaService: PrismaService,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
    private readonly emailOriginalService: EmailOriginalService,
  ) {}

  async findAll() {
    const emails = await this.prismaService.emailMessage.findMany({
      orderBy: { receivedAt: 'desc' },
      select: {
        id: true,
        graphMessageId: true,
        conversationId: true,
        threadKey: true,
        fromEmail: true,
        subject: true,
        receivedAt: true,
        status: true,
        isTransportOrder: true,
        hasAttachments: true,
        classificationReason: true,
        classifiedAt: true,
        mailbox: {
          select: {
            id: true,
            email: true,
            department: true,
            active: true,
            lastSyncedAt: true,
          },
        },
      },
    });

    return emails.map((e) => ({
      id: e.id,
      providerMessageId: e.graphMessageId,
      conversationId: e.conversationId,
      threadKey: e.threadKey,
      fromEmail: e.fromEmail,
      subject: e.subject,
      receivedAt: e.receivedAt,
      status: e.status,
      isTransportOrder: e.isTransportOrder,
      hasAttachments: e.hasAttachments,
      classificationReason: e.classificationReason,
      classifiedAt: e.classifiedAt,
      mailbox: e.mailbox,
    }));
  }

  private async enqueueProcessing(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      select: { id: true, graphMessageId: true },
    });
    if (!email) throw new NotFoundException(`Email not found: id=${id}`);

    await this.emailProcessingQueue.add('process-email', {
      emailMessageId: email.id,
      graphMessageId: email.graphMessageId,
    });

    return email;
  }

  /** Re-run the full pipeline (re-classifies, then proceeds if transport). */
  async reclassify(id: string) {
    await this.enqueueProcessing(id);
    return { enqueued: true };
  }

  /**
   * Manual override for a false negative: mark the email as a transport order so
   * the classification gate is skipped, then reprocess to create the order.
   */
  async processAnyway(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!email) throw new NotFoundException(`Email not found: id=${id}`);

    await this.prismaService.emailMessage.update({
      where: { id },
      data: { isTransportOrder: true },
    });

    await this.enqueueProcessing(id);
    return { enqueued: true };
  }

  async findOne(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      include: {
        mailbox: true,
        attachments: true,
        // Only the fields the response actually uses — a batch email can carry
        // dozens of orders, and full rows include heavy columns (rawOrderText)
        // that would bloat the detail payload for nothing (timeout on big batches).
        orders: {
          orderBy: { batchSequence: 'asc' },
          select: {
            id: true,
            status: true,
            externalReference: true,
            batchSequence: true,
            department: true,
            type: true,
            overallConfidence: true,
            customerEmail: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        batchImports: { orderBy: { createdAt: 'desc' }, take: 1 },
        linkedOrder: true,
      },
    });

    if (!email) {
      throw new NotFoundException(`Email not found: id=${id}`);
    }

    // Legacy single-order shape: the first order is the primary one.
    const order = email.orders?.[0] ?? email.linkedOrder;
    const batchImport = email.batchImports?.[0] ?? null;

    // Niek: flag which attachments are embedded in the Creative Gears XML, so
    // the order detail can mark them. Same rule the XML builder uses.
    const docsEnabled = xmlDocumentsEnabled();

    // Niek (2026-09-11): show the documenttype each document gets in the XML,
    // and list the original e-mail itself as a document (type 19). The
    // per-profile documenttype rules are keyed by the customer's email, matched
    // the same way the XML builder does (resolveDocumentTypeRules in xml.service).
    const customerEmail = (
      order?.customerEmail ??
      email.linkedOrder?.customerEmail ??
      email.fromEmail ??
      ''
    )
      .trim()
      .toLowerCase();
    const documentTypeRules = customerEmail
      ? await this.resolveDocumentTypeRules(customerEmail)
      : {};

    // Each document that will be embedded in the <documents> block, with its
    // resolved documenttype — the original e-mail first (type 19), then every
    // included attachment. Empty when documents are disabled.
    const emailDocument =
      docsEnabled && email.rawMimeBase64?.trim()
        ? {
            fileName:
              (email.rawMimeFileName || '').trim() || 'original-email.eml',
            mimeType: 'message/rfc822',
            documentType: EMAIL_DOCUMENT_TYPE,
            concerns: concernsForDocumentType(EMAIL_DOCUMENT_TYPE),
          }
        : null;

    return {
      id: email.id,
      providerMessageId: email.graphMessageId,
      graphMessageId: email.graphMessageId,
      conversationId: email.conversationId,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      receivedAt: email.receivedAt,
      hasAttachments: email.hasAttachments,
      status: email.status,
      isTransportOrder: email.isTransportOrder,
      classificationReason: email.classificationReason,
      classificationLanguage: email.classificationLanguage,
      classifiedAt: email.classifiedAt,
      mailbox: email.mailbox,
      attachments: email.attachments.map((att) => {
        const includedInXml = docsEnabled && isXmlDocumentAttachment(att);
        const documentType = includedInXml
          ? resolveAttachmentDocumentType({
              fileName: att.fileName,
              mimeType: att.mimeType,
              documentPurpose: att.documentPurpose,
              rules: documentTypeRules,
            })
          : null;
        return {
          ...att,
          includedInXml,
          // Niek: the Transpas documenttype this file goes out as (per-profile
          // rule > AI purpose > default 92), so the panel can show it.
          documentType,
          concerns: documentType ? concernsForDocumentType(documentType) : null,
        };
      }),
      // The original e-mail as an XML document (type 19), shown in the panel
      // alongside the attachments so operators see everything that is sent.
      emailDocument,
      order: order
        ? {
            id: order.id,
            status: order.status,
            department: order.department,
            type: order.type,
            overallConfidence: order.overallConfidence,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          }
        : null,
      // Batch: when one email produced several orders.
      batch: batchImport
        ? {
            id: batchImport.id,
            status: batchImport.status,
            totalDetected: batchImport.totalDetected,
            totalCreated: batchImport.totalCreated,
            totalFailed: batchImport.totalFailed,
            reason: batchImport.reason,
          }
        : null,
      orders: email.orders.map((o) => ({
        id: o.id,
        status: o.status,
        externalReference: o.externalReference,
        batchSequence: o.batchSequence,
      })),
    };
  }

  /**
   * Per-profile documenttype rules (Sander) for a customer, matched by email
   * against the profile's primary/additional addresses. Twin of
   * XmlService.resolveDocumentTypeRules so the panel shows exactly the
   * documenttype the XML builder will emit. {} when no profile or no rules.
   */
  private async resolveDocumentTypeRules(customerEmail?: string | null) {
    const email = (customerEmail || '').trim().toLowerCase();
    if (!email) return {};
    const profile = await this.prismaService.customerProfile.findFirst({
      where: {
        active: true,
        OR: [{ contactEmail: email }, { emails: { some: { email } } }],
      },
      select: { documentTypeRules: true },
    });
    return normalizeDocumentTypeRules(profile?.documentTypeRules);
  }

  /** Rebuild the email as received (HTML + embedded signature images). */
  async findOriginal(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      select: {
        id: true,
        subject: true,
        fromEmail: true,
        fromName: true,
        receivedAt: true,
        rawMimeBase64: true,
        bodyHtml: true,
        bodyText: true,
      },
    });
    if (!email) throw new NotFoundException(`Email not found: id=${id}`);

    const rendered = await this.emailOriginalService.render({
      rawMimeBase64: email.rawMimeBase64,
      bodyHtml: email.bodyHtml,
      bodyText: email.bodyText,
    });

    return {
      id: email.id,
      subject: email.subject,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      receivedAt: email.receivedAt,
      ...rendered,
    };
  }

  /**
   * Delete ALL emails. Because TransportOrder and BatchImport both cascade on
   * their emailMessage FK, this also removes every order, batch, attachment and
   * their children in one shot. Client profiles, mailboxes and users are NOT
   * touched (they don't reference EmailMessage). Auth-guarded at the controller.
   */
  async removeAll() {
    const result = await this.prismaService.emailMessage.deleteMany({});
    return { deleted: result.count };
  }

  async remove(id: string) {
    const email = await this.prismaService.emailMessage.findUnique({
      where: { id },
      include: {
        orders: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!email) {
      throw new NotFoundException(`Email not found: id=${id}`);
    }

    const orderIds = email.orders.map((order) => order.id);

    const deletedReplyEmailsCount = await this.prismaService.$transaction(
      async (tx) => {
        if (orderIds.length === 0) {
          await tx.emailMessage.delete({
            where: { id },
          });

          return 0;
        }

        // Replies are linked to any of this email's orders. Exclude the email
        // itself: if its own linkedOrderId points at one of its orders, it must
        // not be deleted here (the explicit delete below handles it + cascade).
        const linkedReplies = await tx.emailMessage.findMany({
          where: { linkedOrderId: { in: orderIds }, id: { not: id } },
          select: { id: true },
        });

        const linkedReplyIds = linkedReplies.map((reply) => reply.id);

        if (linkedReplyIds.length > 0) {
          await tx.emailMessage.deleteMany({
            where: {
              id: { in: linkedReplyIds },
            },
          });
        }

        // Cascade removes the email's own orders.
        await tx.emailMessage.delete({
          where: { id },
        });

        return linkedReplyIds.length;
      },
    );

    return {
      ok: true,
      deletedEmailId: id,
      deletedOrderId: orderIds[0] ?? null,
      deletedReplyEmailsCount,
    };
  }
}
