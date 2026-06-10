import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomerReplyDraftStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  normalizeEscapedNewlines,
  sanitizeExtractedValue,
} from '../../utils/sanitize';

@Injectable()
export class AiReplyService {
  private readonly logger = new Logger(AiReplyService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private resolveAiReplyUrl() {
    const rawBase = (
      this.configService.get<string>('AI_API_BASE_URL') || ''
    ).trim();
    const rawPath = (
      this.configService.get<string>('AI_REPLY_API_URL') || ''
    ).trim();
    if (!rawBase) return '';
    if (!rawPath) return '';

    const normalizeBase = (b: string) => b.replace(/\/+$/, '');
    const normalizePath = (p: string) => (p.startsWith('/') ? p : `/${p}`);
    return `${normalizeBase(rawBase)}${normalizePath(rawPath)}`;
  }

  private getApiKey() {
    return (this.configService.get<string>('AI_API_KEY') || '').trim();
  }

  private shortOrderId(orderId: string) {
    return (orderId || '').split('-')[0] || '';
  }

  private buildReplyToken(orderId: string) {
    const short = this.shortOrderId(orderId);
    return short ? `PULTRUM-${short}` : null;
  }

  private ensureTokenInBody(body: string, token: string | null) {
    const trimmed = (body || '').toString().trim();
    if (!token) return trimmed;
    const marker = `[${token}]`;
    if (trimmed.includes(marker)) return trimmed;
    return `${trimmed}\n\nReference: ${marker}`;
  }

  private ensureTokenInSubject(subject: string, token: string | null) {
    const s = (subject || '').toString().trim();
    if (!token) return s;
    const marker = `[${token}]`;
    if (!s) return `Aanvullende informatie nodig - ${marker}`;
    if (s.includes(marker)) return s;
    return `${s} - ${marker}`;
  }

  private normalizeDraftBody(body: string) {
    return normalizeEscapedNewlines(body || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private detectLanguage(input: {
    subject?: string | null;
    bodyText?: string | null;
  }) {
    const text =
      `${input.subject ?? ''}\n${input.bodyText ?? ''}`.toLowerCase();
    if (
      /(laaddatum|losdatum|laadreferentie|losreferentie|laadtijd|lostijd)/i.test(
        text,
      )
    )
      return 'nl';
    if (/(pickup|delivery|loading|unloading)/i.test(text)) return 'en';
    if (
      /(carregamento|descarga|retirada|entrega|endereco|endereÃ§o|endere\u00e7o)/i.test(
        text,
      )
    )
      return 'pt';
    return 'unknown';
  }

  private parseReplyResponse(raw: any): { subject?: string; body?: string } {
    if (!raw) return {};

    if (raw && typeof raw === 'object') {
      const subject = (raw as any).subject;
      const body = (raw as any).body;
      if (typeof subject === 'string' || typeof body === 'string') {
        return {
          subject: typeof subject === 'string' ? subject : undefined,
          body: typeof body === 'string' ? body : undefined,
        };
      }

      const output = (raw as any).output;
      if (typeof output === 'string' && output.trim()) return { body: output };

      // Some gateways wrap into { data: {...} }
      const data = (raw as any).data;
      if (data && typeof data === 'object')
        return this.parseReplyResponse(data);
    }

    return {};
  }

  async generateMissingInfoReply(orderId: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: true,
        fields: true,
        missingFields: true,
        validationWarnings: true,
      },
    });
    if (!order) throw new Error(`TransportOrder not found: id=${orderId}`);
    if (!order.emailMessage)
      throw new Error(`EmailMessage not found for orderId=${orderId}`);

    const token = order.replyToken || this.buildReplyToken(order.id);
    if (token && token !== order.replyToken) {
      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: { replyToken: token, conversationKey: token },
      });
    }

    const url = this.resolveAiReplyUrl();
    if (!url)
      throw new Error(
        'AI reply URL not configured (AI_API_BASE_URL/AI_REPLY_API_URL)',
      );
    const apiKey = this.getApiKey();

    const email = order.emailMessage as any;
    const payload = {
      orderId: order.id,
      department: order.department ?? null,
      customerEmail: order.customerEmail ?? null,
      subject: email.subject ?? null,
      bodyText: email.bodyText ?? null,
      detectedFields: (order.fields ?? [])
        .filter((f) => (f.value ?? '').toString().trim().length > 0)
        .map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          confidence: f.confidence ?? null,
          source: f.source ?? null,
        })),
      missingFields: (order.missingFields ?? []).map((m) => ({
        key: m.key,
        label: m.label,
        reason: m.reason ?? null,
      })),
      validationWarnings: (order.validationWarnings ?? []).map((warning) => ({
        key: warning.key,
        label: warning.label,
        reason: warning.reason ?? null,
      })),
      language: this.detectLanguage({
        subject: email.subject ?? null,
        bodyText: email.bodyText ?? null,
      }),
      replyToken: token,
    };

    this.logger.log(`AI reply draft started orderId=${order.id}`);

    await this.auditLogService.log({
      entityType: 'TransportOrder',
      entityId: order.id,
      action: 'AI_REPLY_REQUESTED',
      detailsJson: {
        url,
        missingFieldsCount: payload.missingFields.length,
        validationWarningsCount: payload.validationWarnings.length,
        detectedFieldsCount: payload.detectedFields.length,
      },
    });

    try {
      const timeoutMs = Number(
        this.configService.get<string>('AI_REPLY_TIMEOUT_MS') || '120000',
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const contentType = res.headers.get('content-type') || '';
      const raw = contentType.includes('application/json')
        ? await res.json()
        : { raw: await res.text() };

      if (!res.ok) {
        const preview = (() => {
          try {
            return JSON.stringify(raw).slice(0, 1200);
          } catch {
            return String(raw).slice(0, 1200);
          }
        })();
        this.logger.warn(
          `AI reply API error orderId=${order.id} status=${res.status} preview=${preview}`,
        );
        await this.auditLogService.log({
          entityType: 'TransportOrder',
          entityId: order.id,
          action: 'AI_REPLY_FAILED',
          detailsJson: { status: res.status, preview },
        });
        throw new Error(`AI reply API error: status=${res.status}`);
      }

      const parsed = this.parseReplyResponse(raw);
      const suggestedSubject =
        typeof parsed.subject === 'string' ? parsed.subject : '';
      const suggestedBody = typeof parsed.body === 'string' ? parsed.body : '';

      const cleanedBody = this.normalizeDraftBody(suggestedBody || '');
      const cleanedSubject = sanitizeExtractedValue(suggestedSubject || '');

      const finalSubject = this.ensureTokenInSubject(
        cleanedSubject || `Aanvullende informatie nodig - [${token}]`,
        token,
      );
      const finalBody = this.ensureTokenInBody(cleanedBody, token);

      const draft = await this.prismaService.customerReplyDraft.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          aiRequestId: null,
          toEmail: order.customerEmail ?? '',
          subject: finalSubject,
          body: finalBody,
          status: CustomerReplyDraftStatus.DRAFT,
        },
        update: {
          toEmail: order.customerEmail ?? '',
          subject: finalSubject,
          body: finalBody,
          status: CustomerReplyDraftStatus.DRAFT,
        },
      });

      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: order.id,
        action: 'AI_REPLY_DRAFT_CREATED',
        detailsJson: {
          replyToken: token,
          toEmail: draft.toEmail,
        },
      });

      this.logger.log(
        `AI reply draft completed orderId=${order.id} detected=${payload.detectedFields.length} missing=${payload.missingFields.length}`,
      );

      return { ok: true, draft };
    } catch (err: any) {
      this.logger.warn(
        `AI reply draft failed orderId=${order.id}: ${err?.message ?? err}`,
      );
      await this.auditLogService.log({
        entityType: 'TransportOrder',
        entityId: order.id,
        action: 'AI_REPLY_FAILED',
        detailsJson: { message: err?.message ?? String(err) },
      });
      throw err;
    }
  }
}
