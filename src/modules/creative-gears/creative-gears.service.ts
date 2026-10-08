import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, XmlDeliveryStatus } from '@prisma/client';
import 'isomorphic-fetch';
import { PrismaService } from '../../prisma/prisma.service';
import { XmlService } from '../xml/xml.service';
import { AlertsService } from '../alerts/alerts.service';
import { EmailSenderService } from '../email-sender/email-sender.service';
import {
  SystemSettingsService,
  type ConfirmationLang,
} from '../system-settings/system-settings.service';

@Injectable()
export class CreativeGearsService {
  private readonly logger = new Logger(CreativeGearsService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly xmlService: XmlService,
    private readonly configService: ConfigService,
    private readonly alertsService: AlertsService,
    private readonly emailSenderService: EmailSenderService,
    private readonly systemSettingsService: SystemSettingsService,
  ) {}

  // --- XML-sent confirmation reply (Niek 2026-10-07) ----------------------
  // When an order is accepted by Transpas, send the customer a short NL
  // confirmation. One per e-mail/batch (idempotent via the audit log). The
  // on/off switch and the template are edited by Niek in Settings (SystemSettings).

  private timeGreeting(lang: ConfirmationLang): string {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    const slot = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const greetings: Record<ConfirmationLang, Record<string, string>> = {
      nl: { morning: 'Goedemorgen', afternoon: 'Goedemiddag', evening: 'Goedenavond' },
      en: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' },
      de: { morning: 'Guten Morgen', afternoon: 'Guten Tag', evening: 'Guten Abend' },
    };
    return greetings[lang][slot];
  }

  /** Best-effort: never breaks the delivery flow. */
  private async sendAcceptedConfirmation(orderId: string): Promise<void> {
    try {
      const order = await this.prismaService.transportOrder.findUnique({
        where: { id: orderId },
        include: { emailMessage: { include: { mailbox: true } } },
      });
      if (!order) return;

      // Resolve the template for the customer e-mail's language (NL/EN/DE),
      // falling back to Dutch when that language has no template or is unknown.
      const config = await this.systemSettingsService.getXmlConfirmationConfig(
        order.emailMessage?.classificationLanguage ?? null,
      );
      if (!config.enabled) return;

      const emailId = order.emailMessageId;
      const toEmail =
        order.customerEmail || order.emailMessage?.fromEmail || null;
      if (!toEmail) return;

      // All orders from this e-mail (also used for the {orders} list).
      const siblings = await this.prismaService.transportOrder.findMany({
        where: { emailMessageId: emailId },
        select: {
          id: true,
          status: true,
          externalReference: true,
          originalOrderReference: true,
          batchSequence: true,
        },
        orderBy: { batchSequence: 'asc' },
      });

      // Only confirm once the WHOLE e-mail is accepted (Niek 2026-10-07): a
      // single-order e-mail fires immediately; a batch fires on the last accept.
      const allAccepted =
        siblings.length > 0 &&
        siblings.every(
          (s) => s.status === OrderStatus.CREATIVE_GEARS_ACCEPTED,
        );
      if (!allAccepted) return;

      // Idempotency: one confirmation per e-mail/batch.
      const already = await this.prismaService.auditLog.findFirst({
        where: {
          entityType: 'EmailMessage',
          entityId: emailId,
          action: 'XML_CONFIRMATION_SENT',
        },
        select: { id: true },
      });
      if (already) return;

      // Subject: Niek's custom subject if set, else reply to the original.
      const original = (order.emailMessage?.subject || '').trim();
      const subject = config.subject
        ? config.subject
        : !original
          ? 'Bevestiging'
          : /^re:/i.test(original)
            ? original
            : `Re: ${original}`;
      // Reference list of all orders from this e-mail (for the {orders} token).
      const refs = siblings
        .map(
          (s) =>
            (s.externalReference || s.originalOrderReference || '').trim() ||
            s.id.split('-')[0],
        )
        .filter(Boolean);
      // De-dup while keeping order (batch legs can share a reference).
      const ordersList = [...new Set(refs)].map((r) => `- ${r}`).join('\n');

      // Body from the editable template; {greeting} -> time-based greeting in the
      // resolved language, {orders} -> the reference list of the processed order(s).
      const body = config.body
        .replace(/\{greeting\}/g, this.timeGreeting(config.lang))
        .replace(/\{orders\}/g, ordersList);

      const sendResult = await this.emailSenderService.sendEmail({
        mailboxEmail: order.emailMessage?.mailbox?.email ?? null,
        toEmail,
        subject,
        body,
        replyTo: null,
        inReplyTo: order.emailMessage?.messageIdHeader ?? null,
        references: order.emailMessage?.messageIdHeader ?? null,
        replyToGraphMessageId: order.emailMessage?.graphMessageId ?? null,
        signature: null,
      });

      await this.prismaService.auditLog.create({
        data: {
          entityType: 'EmailMessage',
          entityId: emailId,
          action: 'XML_CONFIRMATION_SENT',
          detailsJson: {
            orderId,
            toEmail,
            subject,
            lang: config.lang,
            provider: sendResult.provider,
            mocked: sendResult.mocked,
            messageId: sendResult.messageId ?? null,
          } as any,
        },
      });
      this.logger.log(
        `XML-sent confirmation e-mailed to ${toEmail} (orderId=${orderId})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `XML-sent confirmation failed orderId=${orderId}: ${err?.message ?? err}`,
      );
    }
  }

  private get apiUrl() {
    return (
      this.configService.get<string>('CREATIVE_GEARS_API_URL') || ''
    ).trim();
  }

  private get username() {
    return (
      this.configService.get<string>('CREATIVE_GEARS_USERNAME') || ''
    ).trim();
  }

  private get password() {
    return this.configService.get<string>('CREATIVE_GEARS_PASSWORD') || '';
  }

  private buildBasicAuthHeader() {
    const user = this.username;
    const pass = this.password;
    if (!user || !pass) return null;
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    return `Basic ${token}`;
  }

  private responsePreview(value: string | null | undefined) {
    const text = (value ?? '').trim();
    if (!text) return '(empty response)';
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
  }

  private async getOrCreatePendingXmlDelivery(orderId: string, force = false) {
    // ALWAYS regenerate from current data before sending. The PENDING payload is
    // only a preview cache — it goes stale when the order or its customer profile
    // changes (e.g. per-file documenttypes, Renato 2026-09-09), and reusing it
    // would deliver outdated XML to Creative Gears. generateOrderXml updates the
    // existing PENDING row in place (or creates one), so we send exactly what a
    // fresh preview shows. `force` lets an incomplete order through (customer_id
    // still required) — Niek 2026-09-11.
    await this.xmlService.generateOrderXml(orderId, { force });

    const pending = await this.prismaService.xmlDelivery.findFirst({
      where: { orderId, status: XmlDeliveryStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending?.xmlPayload) {
      throw new Error(
        `XmlDelivery PENDING not found after generation: orderId=${orderId}`,
      );
    }

    return pending;
  }

  async sendXmlDelivery(orderId: string, force = false) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new Error(`TransportOrder not found: id=${orderId}`);

    const delivery = await this.getOrCreatePendingXmlDelivery(orderId, force);
    const xmlPayload = delivery.xmlPayload;
    if (!xmlPayload)
      throw new Error(`XmlDelivery has no xmlPayload: id=${delivery.id}`);

    const apiUrl = this.apiUrl;
    if (!apiUrl) {
      // Mock mode
      await this.prismaService.$transaction(async (tx) => {
        await tx.transportOrder.update({
          where: { id: orderId },
          data: { status: OrderStatus.CREATIVE_GEARS_ACCEPTED },
        });
        await tx.xmlDelivery.update({
          where: { id: delivery.id },
          data: {
            status: XmlDeliveryStatus.ACCEPTED,
            requestPayload: xmlPayload,
            responsePayload: 'MOCK: CREATIVE_GEARS_API_URL not configured',
            errorMessage: null,
            sentAt: new Date(),
          },
        });
      });

      this.logger.warn(
        `CREATIVE_GEARS_API_URL not configured; mocking ACCEPTED for orderId=${orderId}`,
      );
      await this.sendAcceptedConfirmation(orderId);
      return { mocked: true, status: 'ACCEPTED' as const };
    }

    const authHeader = this.buildBasicAuthHeader();
    if (!authHeader) {
      throw new Error(
        'Creative Gears Basic Auth is not configured. Set CREATIVE_GEARS_USERNAME and CREATIVE_GEARS_PASSWORD.',
      );
    }

    const startedAt = new Date();
    let res: Response | null = null;
    let responseText = '';
    const controller = new AbortController();
    const timeoutMs = 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
          Authorization: authHeader,
        },
        body: xmlPayload,
        signal: controller.signal,
      });
      responseText = await res.text();

      const accepted = res.ok;
      const is4xx = res.status >= 400 && res.status < 500;

      const deliveryStatus = accepted
        ? XmlDeliveryStatus.ACCEPTED
        : is4xx
          ? XmlDeliveryStatus.REJECTED
          : XmlDeliveryStatus.FAILED;

      const orderStatus = accepted
        ? OrderStatus.CREATIVE_GEARS_ACCEPTED
        : is4xx
          ? OrderStatus.CREATIVE_GEARS_REJECTED
          : OrderStatus.FAILED;

      await this.prismaService.$transaction(async (tx) => {
        await tx.xmlDelivery.update({
          where: { id: delivery.id },
          data: {
            status: deliveryStatus,
            requestPayload: xmlPayload,
            responsePayload: responseText || null,
            errorMessage: accepted
              ? null
              : `HTTP ${res?.status} ${res?.statusText}`,
            sentAt: startedAt,
          },
        });
        await tx.transportOrder.update({
          where: { id: orderId },
          data: { status: orderStatus },
        });
      });

      if (accepted) {
        this.logger.log(
          `Creative Gears accepted XML: orderId=${orderId} deliveryId=${delivery.id} status=${res.status}`,
        );
        await this.sendAcceptedConfirmation(orderId);
      } else {
        this.logger.warn(
          `Creative Gears rejected XML: orderId=${orderId} deliveryId=${delivery.id} status=${res.status} ${res.statusText} response=${this.responsePreview(responseText)}`,
        );
        void this.alertsService.notifyIncident({
          type: 'xml',
          title: 'XML rejeitado pela Creative Gears',
          reference: orderId,
          error: `HTTP ${res.status} ${res.statusText} — ${this.responsePreview(responseText)}`,
        });
      }

      return {
        mocked: false,
        httpStatus: res.status,
        accepted,
        deliveryStatus,
        orderStatus,
      };
    } catch (err: any) {
      const message =
        err?.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : err?.message ?? String(err);
      await this.prismaService.$transaction(async (tx) => {
        await tx.xmlDelivery.update({
          where: { id: delivery.id },
          data: {
            status: XmlDeliveryStatus.FAILED,
            requestPayload: xmlPayload,
            responsePayload: responseText || null,
            errorMessage: message,
            sentAt: startedAt,
          },
        });
        await tx.transportOrder.update({
          where: { id: orderId },
          data: { status: OrderStatus.FAILED },
        });
      });
      this.logger.error(
        `Creative Gears XML delivery failed: orderId=${orderId} deliveryId=${delivery.id} error=${message} response=${this.responsePreview(responseText)}`,
      );
      void this.alertsService.notifyIncident({
        type: 'xml',
        title: 'Falha no envio do XML',
        reference: orderId,
        error: message,
      });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
