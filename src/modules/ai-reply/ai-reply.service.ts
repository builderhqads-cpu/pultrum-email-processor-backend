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

  private ensureTokenInBody(body: string, _token: string | null) {
    // No token in the body anymore — reply linking relies on conversationId,
    // In-Reply-To and Message-ID headers only.
    return (body || '').toString().trim();
  }

  private ensureTokenInSubject(subject: string, _token: string | null) {
    // The PULTRUM token lives in the body only — the subject stays clean and
    // fully editable. Strip any token the model may have added. Thread linking
    // relies on conversationId / RFC headers, with the body token as fallback.
    const s = (subject || '')
      .toString()
      .replace(/\s*-?\s*\[(?:PULTRUM|RENOVO)-[^\]]+\]/gi, '')
      .trim();
    return s || 'Aanvullende informatie nodig';
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

  /**
   * A reply body must be human prose, never a JSON payload. The eml-process
   * route returns the extraction in an `output` field (a JSON string); if a
   * reply route echoes that shape we must NOT use it as the e-mail body.
   */
  private isJsonLike(s: unknown): boolean {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
    try {
      return typeof JSON.parse(t) === 'object';
    } catch {
      return false;
    }
  }

  private parseReplyResponse(raw: any): { subject?: string; body?: string } {
    if (!raw) return {};

    if (raw && typeof raw === 'object') {
      const subject = (raw as any).subject;
      const body = (raw as any).body;
      if (
        (typeof subject === 'string' && !this.isJsonLike(subject)) ||
        (typeof body === 'string' && !this.isJsonLike(body))
      ) {
        return {
          subject:
            typeof subject === 'string' && !this.isJsonLike(subject)
              ? subject
              : undefined,
          body:
            typeof body === 'string' && !this.isJsonLike(body)
              ? body
              : undefined,
        };
      }

      const output = (raw as any).output;
      if (typeof output === 'string' && output.trim() && !this.isJsonLike(output))
        return { body: output };

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

  /**
   * CONSOLIDATED missing-info reply for a whole batch (multiple orders from one
   * email). Instead of one e-mail per incomplete order, we produce ONE draft
   * that lists, grouped by order reference, every field still missing across the
   * batch. The draft is anchored on the batch's primary order so the customer's
   * answer threads back, and {@link processReplyViaAiAnalysis} then distributes
   * the answers to each order by its external reference.
   *
   * The reply TEXT is meant to be generated by the AI (Matheus). Until that
   * route/contract is confirmed, this falls back to a deterministic template in
   * the e-mail's language. Set AI_CONSOLIDATED_REPLY_API_URL (or the existing
   * AI_REPLY_API_URL is reused) to switch to AI-generated copy.
   */
  async generateConsolidatedMissingInfoReply(batchImportId: string) {
    const batch = await this.prismaService.batchImport.findUnique({
      where: { id: batchImportId },
      include: {
        emailMessage: true,
        orders: {
          orderBy: { batchSequence: 'asc' },
          include: { missingFields: true, fields: true },
        },
      },
    });
    if (!batch) throw new Error(`BatchImport not found: id=${batchImportId}`);

    const orders = batch.orders ?? [];
    if (orders.length === 0) return null;

    // Only the orders that still need something from the customer.
    const incomplete = orders.filter((o) => (o.missingFields?.length ?? 0) > 0);
    if (incomplete.length === 0) return null;

    // Anchor the single draft on the primary order (lowest sequence) so the
    // reply threads back and we have a stable order to attach the draft to.
    const anchor = orders[0];
    const token = anchor.replyToken || this.buildReplyToken(anchor.id);
    if (token && token !== anchor.replyToken) {
      await this.prismaService.transportOrder.update({
        where: { id: anchor.id },
        data: { replyToken: token, conversationKey: token },
      });
    }

    const email = batch.emailMessage as any;
    const language = this.detectLanguage({
      subject: email?.subject ?? null,
      bodyText: email?.bodyText ?? null,
    });
    const toEmail = anchor.customerEmail ?? email?.fromEmail ?? '';

    const ordersPayload = incomplete.map((o) => ({
      orderId: o.id,
      reference:
        o.externalReference ||
        (o.batchSequence != null ? `#${o.batchSequence}` : o.id.split('-')[0]),
      detectedFields: (o.fields ?? [])
        .filter((f) => (f.value ?? '').toString().trim().length > 0)
        .map((f) => ({ key: f.key, label: f.label, value: f.value })),
      missingFields: (o.missingFields ?? []).map((m) => ({
        key: m.key,
        label: m.label,
        reason: m.reason ?? null,
      })),
    }));

    // The AI copy (if a consolidated route is configured) wins; otherwise the
    // deterministic template is used so the operator always has a draft to send.
    const aiText = await this.tryConsolidatedAiReply(ordersPayload, {
      language,
      subject: email?.subject ?? null,
      token,
    }).catch((err: any) => {
      this.logger.warn(
        `Consolidated AI reply failed batchId=${batchImportId}: ${err?.message ?? err}`,
      );
      return null;
    });

    const subject =
      aiText?.subject || this.consolidatedTemplateSubject(language);
    const body =
      aiText?.body || this.consolidatedTemplateBody(ordersPayload, language);

    const finalSubject = this.ensureTokenInSubject(
      sanitizeExtractedValue(subject || ''),
      token,
    );
    const finalBody = this.ensureTokenInBody(
      this.normalizeDraftBody(body || ''),
      token,
    );

    const draft = await this.prismaService.customerReplyDraft.upsert({
      where: { orderId: anchor.id },
      create: {
        orderId: anchor.id,
        aiRequestId: null,
        toEmail,
        subject: finalSubject,
        body: finalBody,
        status: CustomerReplyDraftStatus.DRAFT,
      },
      update: {
        toEmail,
        subject: finalSubject,
        body: finalBody,
        status: CustomerReplyDraftStatus.DRAFT,
      },
    });

    // This ONE draft covers the whole batch. Remove any stale per-order DRAFTs
    // on the sibling orders so the operator sees exactly one reply (and never a
    // leftover broken per-order draft). Sent drafts are kept (history).
    const siblingIds = orders
      .filter((o) => o.id !== anchor.id)
      .map((o) => o.id);
    let removedSiblings = 0;
    if (siblingIds.length) {
      const del = await this.prismaService.customerReplyDraft.deleteMany({
        where: {
          orderId: { in: siblingIds },
          status: CustomerReplyDraftStatus.DRAFT,
        },
      });
      removedSiblings = del.count;
    }

    await this.auditLogService.log({
      entityType: 'BatchImport',
      entityId: batchImportId,
      action: 'BATCH_CONSOLIDATED_REPLY_DRAFT_CREATED',
      detailsJson: {
        draftId: draft.id,
        anchorOrderId: anchor.id,
        incompleteOrders: incomplete.length,
        usedAi: Boolean(aiText),
        removedSiblingDrafts: removedSiblings,
      },
    });
    this.logger.log(
      `Consolidated reply draft batchId=${batchImportId} anchor=${anchor.id} incomplete=${incomplete.length} ai=${Boolean(aiText)}`,
    );

    return { ok: true, draft };
  }

  /**
   * Call the (configurable) AI route that returns a consolidated reply for the
   * whole batch. Returns null when no route is configured so the caller falls
   * back to the template. The route/contract is confirmed with Matheus — set
   * AI_CONSOLIDATED_REPLY_API_URL to point at it (defaults to AI_REPLY_API_URL).
   */
  private async tryConsolidatedAiReply(
    orders: Array<{
      orderId: string;
      reference: string;
      detectedFields: Array<{ key: string; label: string; value: unknown }>;
      missingFields: Array<{
        key: string;
        label: string;
        reason: string | null;
      }>;
    }>,
    ctx: { language: string; subject: string | null; token: string | null },
  ): Promise<{ subject?: string; body?: string } | null> {
    const base = (this.configService.get<string>('AI_API_BASE_URL') || '').trim();
    const path = (
      this.configService.get<string>('AI_CONSOLIDATED_REPLY_API_URL') ||
      this.configService.get<string>('AI_REPLY_API_URL') ||
      ''
    ).trim();
    if (!base || !path) return null;
    const url = `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const apiKey = this.getApiKey();

    const timeoutMs = Number(
      this.configService.get<string>('AI_REPLY_TIMEOUT_MS') || '120000',
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          consolidated: true,
          language: ctx.language,
          subject: ctx.subject,
          replyToken: ctx.token,
          orders,
        }),
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      const raw = contentType.includes('application/json')
        ? await res.json()
        : { raw: await res.text() };
      if (!res.ok) {
        throw new Error(`AI consolidated reply error: status=${res.status}`);
      }
      const parsed = this.parseReplyResponse(raw);
      if (!parsed.subject && !parsed.body) return null;
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  private consolidatedTemplateSubject(language: string) {
    const map: Record<string, string> = {
      nl: 'Aanvullende informatie nodig voor uw transportopdrachten',
      de: 'Zusätzliche Informationen für Ihre Transportaufträge erforderlich',
      en: 'Additional information required for your transport orders',
      pt: 'Informações adicionais necessárias para seus pedidos de transporte',
    };
    return map[language] ?? map.nl;
  }

  private consolidatedTemplateBody(
    orders: Array<{
      reference: string;
      missingFields: Array<{ label: string }>;
    }>,
    language: string,
  ) {
    const copy: Record<
      string,
      { intro: string; order: string; outro: string }
    > = {
      nl: {
        intro:
          'Beste,\n\nOm de volgende transportopdrachten te kunnen verwerken, ontbreken nog enkele gegevens. Kunt u per opdracht de onderstaande informatie aanvullen?',
        order: 'Opdracht',
        outro:
          'Alvast bedankt voor uw aanvulling.\n\nMet vriendelijke groet,\nPultrum',
      },
      de: {
        intro:
          'Guten Tag,\n\num die folgenden Transportaufträge bearbeiten zu können, fehlen noch einige Angaben. Können Sie je Auftrag die unten genannten Informationen ergänzen?',
        order: 'Auftrag',
        outro: 'Vielen Dank im Voraus.\n\nMit freundlichen Grüßen,\nPultrum',
      },
      en: {
        intro:
          'Hello,\n\nTo process the following transport orders, some information is still missing. Could you complete the details below for each order?',
        order: 'Order',
        outro: 'Thank you in advance.\n\nKind regards,\nPultrum',
      },
      pt: {
        intro:
          'Olá,\n\nPara processar os seguintes pedidos de transporte, ainda faltam algumas informações. Poderia completar os dados abaixo para cada pedido?',
        order: 'Pedido',
        outro: 'Desde já agradecemos.\n\nAtenciosamente,\nPultrum',
      },
    };
    const t = copy[language] ?? copy.nl;

    const blocks = orders.map((o) => {
      const lines = o.missingFields.map((m) => `   - ${m.label}`).join('\n');
      return `${t.order} ${o.reference}:\n${lines}`;
    });

    return `${t.intro}\n\n${blocks.join('\n\n')}\n\n${t.outro}`;
  }
}
