import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerReplyDraftStatus, OrderStatus } from '@prisma/client';
import { normalizeEscapedNewlines, sanitizeExtractedValue } from '../../utils/sanitize';

@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private resolveAiRequestUrl() {
    const rawUrl = (
      this.configService.get<string>('AI_REPLY_API_URL') ||
      this.configService.get<string>('AI_API_URL') ||
      ''
    ).trim();
    const rawBase = (this.configService.get<string>('AI_API_BASE_URL') || '').trim();

    const normalizeBase = (b: string) => b.replace(/\/+$/, '');
    const normalizePath = (p: string) => (p.startsWith('/') ? p : `/${p}`);

    // If AI_API_URL is a full absolute URL, use it as-is.
    if (rawUrl) {
      try {
        // Throws for relative URLs like "/process"
        // eslint-disable-next-line no-new
        new URL(rawUrl);
        return rawUrl;
      } catch {
        // Relative URL -> needs base
        if (rawBase) return `${normalizeBase(rawBase)}${normalizePath(rawUrl)}`;
        return rawUrl; // will fail later with a clearer error
      }
    }

    // Backward-compatible: if only base is provided, default to /process
    if (rawBase) return `${normalizeBase(rawBase)}/process`;

    return '';
  }

  private buildDraftSubject(orderId: string) {
    const short = (orderId || '').split('-')[0] || '';
    return `Aanvullende informatie nodig - [PULTRUM-${short}]`;
  }

  private buildReplyToken(orderId: string) {
    const short = (orderId || '').split('-')[0] || '';
    if (!short) return null;
    return `PULTRUM-${short}`;
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

  private extractSuggestedReply(responseBody: any): string | null {
    if (!responseBody || typeof responseBody !== 'object') return null;

    // Prefer explicit gateway fields used by our router.
    const replyBody = (responseBody as any).replyBody;
    if (typeof replyBody === 'string' && replyBody.trim()) return replyBody.trim();
    const body = (responseBody as any).body;
    if (typeof body === 'string' && body.trim()) return body.trim();

    const directCandidates = [
      responseBody.output,
      responseBody.output_text,
      responseBody.text,
      responseBody.message,
    ];
    for (const c of directCandidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }

    // OpenAI-style responses (chat completions / responses API wrappers)
    const choices = (responseBody as any).choices;
    if (Array.isArray(choices) && choices.length) {
      const first = choices[0];
      const msgContent = first?.message?.content;
      if (typeof msgContent === 'string' && msgContent.trim()) {
        try {
          const parsed = JSON.parse(msgContent);
          const nested = this.extractSuggestedReply(parsed);
          if (nested) return nested;
        } catch {
          return msgContent.trim();
        }
      }
      const text = first?.text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }

    // Some gateways wrap into { data: {...} }
    const data = (responseBody as any).data;
    if (data && typeof data === 'object') {
      return this.extractSuggestedReply(data);
    }

    const rawResponse = (responseBody as any).rawResponse;
    if (rawResponse && typeof rawResponse === 'object') {
      return this.extractSuggestedReply(rawResponse);
    }

    return null;
  }

  private extractSuggestedSubject(responseBody: any): string | null {
    if (!responseBody || typeof responseBody !== 'object') return null;

    const replySubject = (responseBody as any).replySubject;
    if (typeof replySubject === 'string' && replySubject.trim()) return replySubject.trim();
    const subject = (responseBody as any).subject;
    if (typeof subject === 'string' && subject.trim()) return subject.trim();

    const data = (responseBody as any).data;
    if (data && typeof data === 'object') {
      return this.extractSuggestedSubject(data);
    }

    const choices = (responseBody as any).choices;
    if (Array.isArray(choices) && choices.length) {
      const msgContent = choices[0]?.message?.content;
      if (typeof msgContent === 'string' && msgContent.trim()) {
        try {
          const parsed = JSON.parse(msgContent);
          const nested = this.extractSuggestedSubject(parsed);
          if (nested) return nested;
        } catch {
          return null;
        }
      }
    }

    const rawResponse = (responseBody as any).rawResponse;
    if (rawResponse && typeof rawResponse === 'object') {
      return this.extractSuggestedSubject(rawResponse);
    }

    return null;
  }

  async sendMissingInfoRequest(orderId: string) {
    const order = await this.prismaService.transportOrder.findUnique({
      where: { id: orderId },
      include: {
        emailMessage: { include: { attachments: true } },
        missingFields: true,
        validationWarnings: true,
        fields: true,
      },
    });

    if (!order) {
      throw new Error(`TransportOrder not found: id=${orderId}`);
    }

    // Ensure a stable token that can be used to link customer replies.
    const replyToken = order.replyToken || this.buildReplyToken(order.id);
    if (replyToken && (!order.replyToken || !order.conversationKey)) {
      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: {
          replyToken: order.replyToken ?? replyToken,
          conversationKey: order.conversationKey ?? replyToken,
        },
      });
    }

    const attachmentsText =
      (order.emailMessage.attachments || [])
        .map((a) => (a.extractedText || '').toString().trim())
        .filter(Boolean)
        .join('\n\n') || null;

    const combinedTextParts: string[] = [];
    if (order.emailMessage.subject)
      combinedTextParts.push(`Subject:\n${order.emailMessage.subject}`);
    if (order.emailMessage.bodyText)
      combinedTextParts.push(`BodyText:\n${order.emailMessage.bodyText}`);
    if (order.emailMessage.bodyHtml) {
      const sanitizedHtml = sanitizeExtractedValue(order.emailMessage.bodyHtml);
      if (sanitizedHtml) combinedTextParts.push(`BodyHtml:\n${sanitizedHtml}`);
    }
    if (order.emailMessage.attachments?.length) {
      const attParts = order.emailMessage.attachments
        .map((a) => {
          const lines: string[] = [];
          if (a.fileName) lines.push(`AttachmentFileName: ${a.fileName}`);
          if (a.extractedText) lines.push(`AttachmentExtractedText:\n${a.extractedText}`);
          return lines.join('\n');
        })
        .filter((x) => x.trim().length > 0);
      if (attParts.length) combinedTextParts.push(attParts.join('\n\n'));
    }
    const combinedText = combinedTextParts.join('\n\n') || null;

    const payload = {
      orderId: order.id,
      customerEmail: order.customerEmail,
      subject: order.emailMessage.subject,
      bodyText: order.emailMessage.bodyText ?? '',
      attachmentsText,
      combinedText,
      department: order.department,
      replyToken,
      missingFields: order.missingFields.map((m) => ({
        key: m.key,
        label: m.label,
        reason: m.reason ?? null,
      })),
      validationWarnings: order.validationWarnings.map((w) => ({
        key: w.key,
        label: w.label,
        reason: w.reason ?? null,
      })),
      detectedFields: order.fields
        .filter((f) => !f.missing)
        .map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value ?? null,
          confidence: f.confidence ?? null,
        })),
    };

    const aiApiUrl = this.resolveAiRequestUrl();
    const aiApiKey = (
      this.configService.get<string>('AI_API_KEY') || ''
    ).trim();

    if (!aiApiUrl) {
      const mockedResponse = {
        mocked: true,
        message: 'AI_API_URL/AI_API_BASE_URL not configured',
      };

      const created = await this.prismaService.aiRequest.create({
        data: {
          orderId: order.id,
          payloadJson: payload as any,
          responseJson: mockedResponse as any,
          status: 'MOCKED',
        },
      });

      await this.prismaService.customerReplyDraft.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: this.buildDraftSubject(order.id),
          body: this.ensureTokenInBody(mockedResponse.message, replyToken),
          status: CustomerReplyDraftStatus.DRAFT,
        },
        update: {
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: this.buildDraftSubject(order.id),
          body: this.ensureTokenInBody(mockedResponse.message, replyToken),
          status: CustomerReplyDraftStatus.DRAFT,
        },
      });

      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.WAITING_CUSTOMER_RESPONSE },
      });

      this.logger.warn(
        `AI_API_URL not configured; mocked ai-request for orderId=${order.id}`,
      );
      return created;
    }

    // Ensure we never pass a relative URL (Node fetch would throw "Failed to parse URL").
    try {
      // eslint-disable-next-line no-new
      new URL(aiApiUrl);
    } catch {
      throw new Error(
        `AI API URL is invalid. Set AI_API_URL to an absolute URL or set AI_API_BASE_URL + AI_API_URL path. Got: ${aiApiUrl}`,
      );
    }

    const created = await this.prismaService.aiRequest.create({
      data: {
        orderId: order.id,
        payloadJson: payload as any,
        status: 'SENT',
      },
    });

    try {
      const res = await fetch(aiApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(aiApiKey ? { Authorization: `Bearer ${aiApiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const contentType = res.headers.get('content-type') || '';
      const responseBody = contentType.includes('application/json')
        ? await res.json()
        : { raw: await res.text() };

      await this.prismaService.aiRequest.update({
        where: { id: created.id },
        data: {
          responseJson: responseBody,
          status: res.ok ? 'SUCCEEDED' : 'FAILED',
        },
      });

      if (!res.ok) {
        this.logger.warn(
          `AI request failed: status=${res.status} url=${aiApiUrl} orderId=${order.id}`,
        );
      }

      const output = this.extractSuggestedReply(responseBody) ?? undefined;
      const suggestedSubject = this.extractSuggestedSubject(responseBody) ?? undefined;

      const fallbackBody =
        (output ? normalizeEscapedNewlines(output) : '') ||
        `AI response did not include an "output" field.\nStatus: ${res.status}\n\nResponse:\n${JSON.stringify(responseBody, null, 2)}`;

      const bodyWithToken = this.ensureTokenInBody(fallbackBody, replyToken);
      const draftSubject = this.ensureTokenInSubject(
        suggestedSubject || this.buildDraftSubject(order.id),
        replyToken,
      );

      await this.prismaService.customerReplyDraft.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: draftSubject,
          body: bodyWithToken,
          status: CustomerReplyDraftStatus.DRAFT,
        },
        update: {
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: draftSubject,
          body: bodyWithToken,
          status: CustomerReplyDraftStatus.DRAFT,
        },
      });

      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.WAITING_CUSTOMER_RESPONSE },
      });

      return this.prismaService.aiRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
    } catch (err: any) {
      await this.prismaService.aiRequest.update({
        where: { id: created.id },
        data: {
          responseJson: { error: err?.message ?? String(err) } as any,
          status: 'FAILED',
        },
      });

      // Still create a draft so the operator can act, even when AI is down.
      await this.prismaService.customerReplyDraft.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: this.buildDraftSubject(order.id),
          body: this.ensureTokenInBody(
            `AI request failed.\n\nError: ${err?.message ?? String(err)}`,
            replyToken,
          ),
          status: CustomerReplyDraftStatus.DRAFT,
        },
        update: {
          aiRequestId: created.id,
          toEmail: order.customerEmail,
          subject: this.buildDraftSubject(order.id),
          body: this.ensureTokenInBody(
            `AI request failed.\n\nError: ${err?.message ?? String(err)}`,
            replyToken,
          ),
          status: CustomerReplyDraftStatus.DRAFT,
        },
      });

      await this.prismaService.transportOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.WAITING_CUSTOMER_RESPONSE },
      });
      throw err;
    }
  }
}
