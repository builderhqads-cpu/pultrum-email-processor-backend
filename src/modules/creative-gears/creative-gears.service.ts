import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, XmlDeliveryStatus } from '@prisma/client';
import 'isomorphic-fetch';
import { PrismaService } from '../../prisma/prisma.service';
import { XmlService } from '../xml/xml.service';
import { AlertsService } from '../alerts/alerts.service';

@Injectable()
export class CreativeGearsService {
  private readonly logger = new Logger(CreativeGearsService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly xmlService: XmlService,
    private readonly configService: ConfigService,
    private readonly alertsService: AlertsService,
  ) {}

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

  private async getOrCreatePendingXmlDelivery(orderId: string) {
    // ALWAYS regenerate from current data before sending. The PENDING payload is
    // only a preview cache — it goes stale when the order or its customer profile
    // changes (e.g. per-file documenttypes, Renato 2026-09-09), and reusing it
    // would deliver outdated XML to Creative Gears. generateOrderXml updates the
    // existing PENDING row in place (or creates one), so we send exactly what a
    // fresh preview shows.
    await this.xmlService.generateOrderXml(orderId);

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

  async sendXmlDelivery(orderId: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new Error(`TransportOrder not found: id=${orderId}`);

    const delivery = await this.getOrCreatePendingXmlDelivery(orderId);
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
