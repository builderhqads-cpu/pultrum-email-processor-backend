import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  normalizeEscapedNewlines,
  sanitizeExtractedValue,
} from '../../utils/sanitize';

type ReplyPayload = {
  orderId: string;
  department?: string | null;
  customerEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  detectedFields?: Array<{
    key: string;
    label: string;
    value: string | null;
    confidence?: number | null;
    source?: string | null;
  }>;
  missingFields?: Array<{
    key: string;
    label: string;
    reason?: string | null;
  }>;
  validationWarnings?: Array<{
    key: string;
    label: string;
    reason?: string | null;
  }>;
  language?: string | null;
  replyToken?: string | null;
};

type OpenRouterReplyResult = {
  subject: string;
  body: string;
  model: string;
  usage?: unknown;
  rawResponse?: unknown;
};

type OpenRouterReplyOutput = {
  subject?: string;
  body?: string;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: unknown;
};

@Injectable()
export class OpenRouterReplyService {
  private readonly logger = new Logger(OpenRouterReplyService.name);

  constructor(private readonly configService: ConfigService) {}

  async generateMissingInfoReply(
    payload: ReplyPayload,
  ): Promise<OpenRouterReplyResult> {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENROUTER_API_KEY is not configured',
      );
    }

    const model = (
      this.configService.get<string>('OPENROUTER_REPLY_MODEL') ||
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'openai/gpt-4o-mini'
    ).trim();
    const timeoutMs = Number(
      this.configService.get<string>('OPENROUTER_REPLY_TIMEOUT_MS') ||
        this.configService.get<string>('OPENROUTER_TIMEOUT_MS') ||
        '120000',
    );

    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt(payload.language),
        },
        {
          role: 'user',
          content: JSON.stringify({
            orderId: payload.orderId,
            department: payload.department,
            customerEmail: payload.customerEmail,
            subject: payload.subject,
            bodyText: payload.bodyText,
            detectedFields: payload.detectedFields ?? [],
            missingFields: payload.missingFields ?? [],
            validationWarnings: payload.validationWarnings ?? [],
            replyToken: payload.replyToken,
          }),
        },
      ],
      provider: {
        require_parameters: true,
      },
      plugins: [{ id: 'response-healing' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'missing_info_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['subject', 'body'],
            additionalProperties: false,
          },
        },
      },
      temperature: 0.2,
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const raw = this.asChatResponse(await res.json());

      if (!res.ok) {
        this.logger.warn(
          `OpenRouter reply generation failed: status=${res.status} orderId=${payload.orderId}`,
        );
        throw new BadRequestException(
          `OpenRouter reply request failed with status ${res.status}`,
        );
      }

      const parsed = this.parseModelResponse(raw);
      const normalized = this.normalizeResult(parsed, payload);

      return {
        ...normalized,
        model,
        usage: raw.usage,
        rawResponse: raw,
      };
    } catch (err: unknown) {
      if (
        err instanceof BadRequestException ||
        err instanceof ServiceUnavailableException
      ) {
        throw err;
      }

      this.logger.warn(
        `OpenRouter reply request failed for orderId=${payload.orderId}: ${this.getErrorMessage(err)}`,
      );
      throw new BadRequestException(
        `OpenRouter reply request failed: ${this.getErrorMessage(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildSystemPrompt(language?: string | null) {
    const languageInstruction =
      language === 'nl'
        ? 'Write the reply in Dutch.'
        : language === 'pt'
          ? 'Write the reply in Portuguese.'
          : 'Write the reply in English.';

    return [
      'You draft a professional B2B customer reply asking only for the missing transport order information.',
      languageInstruction,
      'Return JSON that matches the schema exactly.',
      'The subject should be short and professional.',
      'The body should read like a real operational email with a greeting, short context, bullet list, and closing.',
      'Always ask for missing required fields.',
      'Recommended missing fields may appear in a short "Also helpful" sentence, but they must not be treated as blocking.',
      'Do not mention detected fields as missing.',
      'Do not invent operational details.',
      'Do not include markdown or HTML.',
      'Do not include JSON explanations or placeholders.',
      'Prefer a compact email suitable for logistics operators.',
    ].join('\n');
  }

  private parseModelResponse(
    raw: OpenRouterChatResponse,
  ): OpenRouterReplyOutput {
    const content = raw.choices?.[0]?.message?.content;

    if (typeof content === 'string' && content.trim()) {
      try {
        return JSON.parse(content) as OpenRouterReplyOutput;
      } catch {
        throw new BadRequestException(
          'OpenRouter returned non-JSON reply content',
        );
      }
    }

    throw new BadRequestException(
      'OpenRouter returned an empty reply response',
    );
  }

  private normalizeResult(
    output: OpenRouterReplyOutput,
    payload: ReplyPayload,
  ) {
    const subject = sanitizeExtractedValue(output.subject ?? '');
    const body = this.formatReplyBody(output.body ?? '', payload);

    if (!subject || !body) {
      throw new BadRequestException(
        'OpenRouter reply response did not include subject and body',
      );
    }

    return { subject, body };
  }

  private asChatResponse(input: unknown): OpenRouterChatResponse {
    if (!this.isChatResponse(input)) {
      throw new BadRequestException('OpenRouter returned an invalid JSON body');
    }

    return input;
  }

  private isChatResponse(input: unknown): input is OpenRouterChatResponse {
    return typeof input === 'object' && input !== null;
  }

  private getErrorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }

  private formatReplyBody(body: string, payload: ReplyPayload) {
    const normalizedBody = this.cleanBody(body);
    const missingLabels = this.getMissingFieldLabels(payload);
    const locale = this.getLocale(payload.language);

    const greeting =
      locale === 'nl'
        ? 'Goedemorgen,'
        : locale === 'pt'
          ? 'Bom dia,'
          : 'Good morning,';
    const intro =
      locale === 'nl'
        ? 'Bedankt voor uw transportaanvraag.'
        : locale === 'pt'
          ? 'Obrigado pelo seu pedido de transporte.'
          : 'Thank you for your transport request.';
    const requestLine =
      locale === 'nl'
        ? 'Om uw order verder te verwerken, hebben wij nog de volgende informatie nodig:'
        : locale === 'pt'
          ? 'Para dar continuidade ao seu pedido, ainda precisamos das seguintes informacoes:'
          : 'To continue processing your order, we still need the following information:';
    const continuation =
      locale === 'nl'
        ? 'Zodra wij deze gegevens ontvangen, gaan wij verder met de verwerking van uw order.'
        : locale === 'pt'
          ? 'Assim que recebermos essas informacoes, seguiremos com o processamento do seu pedido.'
          : 'Once we receive these details, we will continue processing your order.';
    const helpfulLine =
      this.buildRecommendedLine(payload, locale);
    const closing =
      locale === 'nl'
        ? 'Met vriendelijke groet,'
        : locale === 'pt'
          ? 'Atenciosamente,'
          : 'Kind regards,';

    const bulletList =
      missingLabels.length > 0
        ? missingLabels.map((label) => `- ${label}`).join('\n')
        : this.extractBulletLines(normalizedBody);

    if (!bulletList) {
      return normalizedBody;
    }

    return [
      greeting,
      intro,
      requestLine,
      bulletList,
      helpfulLine,
      continuation,
      closing,
      'Pultrum',
    ]
      .filter((part) => part && part.trim().length > 0)
      .join('\n\n')
      .trim();
  }

  private cleanBody(body: string) {
    return normalizeEscapedNewlines(body ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private getMissingFieldLabels(payload: ReplyPayload) {
    return (payload.missingFields ?? [])
      .map((field) => sanitizeExtractedValue(field.label ?? field.key ?? ''))
      .filter((label) => label.length > 0);
  }

  private buildRecommendedLine(payload: ReplyPayload, locale: 'nl' | 'pt' | 'en') {
    const labels = (payload.validationWarnings ?? [])
      .map((field) => sanitizeExtractedValue(field.label ?? field.key ?? ''))
      .filter((label) => label.length > 0);

    if (labels.length === 0) return '';

    const joined = labels.join(', ');
    if (locale === 'nl') {
      return `Ook nuttig om mee te sturen: ${joined}.`;
    }
    if (locale === 'pt') {
      return `Tambem seria util receber: ${joined}.`;
    }
    return `It would also be helpful to receive: ${joined}.`;
  }

  private extractBulletLines(body: string) {
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .join('\n');
  }

  private getLocale(language?: string | null) {
    if (language === 'nl') return 'nl';
    if (language === 'pt') return 'pt';
    return 'en';
  }
}
