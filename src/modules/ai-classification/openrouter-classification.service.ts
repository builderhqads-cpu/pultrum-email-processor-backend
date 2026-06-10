import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiClassificationPayload } from './ai-classification.service';

type OpenRouterClassificationResult = {
  isTransportOrder: boolean;
  reason: string;
  language: string;
  priority: string;
  model: string;
  usage?: unknown;
  rawResponse?: unknown;
};

type OpenRouterModelOutput = {
  isTransportOrder?: boolean;
  reason?: string;
  language?: string;
  priority?: string;
};

type OpenRouterChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
};

@Injectable()
export class OpenRouterClassificationService {
  private readonly logger = new Logger(OpenRouterClassificationService.name);

  constructor(private readonly configService: ConfigService) {}

  async classifyEmail(
    payload: AiClassificationPayload,
  ): Promise<OpenRouterClassificationResult> {
    const apiKey = (
      this.configService.get<string>('OPENROUTER_API_KEY') || ''
    ).trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENROUTER_API_KEY is not configured',
      );
    }

    const model = (
      this.configService.get<string>('OPENROUTER_CLASSIFICATION_MODEL') ||
      this.configService.get<string>('OPENROUTER_MODEL') ||
      'openai/gpt-4o-mini'
    ).trim();
    const timeoutMs = Number(
      this.configService.get<string>('OPENROUTER_CLASSIFICATION_TIMEOUT_MS') ||
        this.configService.get<string>('OPENROUTER_TIMEOUT_MS') ||
        '60000',
    );

    const requestBody = {
      model,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        {
          role: 'user',
          content: JSON.stringify({
            department: payload.department,
            from: payload.from,
            subject: payload.subject,
            bodyText: payload.bodyText,
            attachmentsText: payload.attachmentsText,
            combinedText: payload.combinedText,
          }),
        },
      ],
      provider: { require_parameters: true },
      plugins: [{ id: 'response-healing' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'email_classification',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              isTransportOrder: { type: 'boolean' },
              reason: { type: 'string' },
              language: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'normal', 'high'] },
            },
            required: ['isTransportOrder', 'reason', 'language', 'priority'],
            additionalProperties: false,
          },
        },
      },
      temperature: 0,
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
          `OpenRouter classification failed: status=${res.status} emailId=${payload.emailId}`,
        );
        throw new BadRequestException(
          `OpenRouter request failed with status ${res.status}`,
        );
      }

      const output = this.parseModelResponse(raw);

      return {
        isTransportOrder: Boolean(output.isTransportOrder),
        reason: (output.reason ?? '').toString(),
        language: (output.language ?? '').toString(),
        priority: (output.priority ?? 'normal').toString(),
        model,
        usage: raw?.usage,
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
        `OpenRouter classification request failed for emailId=${payload.emailId}: ${this.getErrorMessage(err)}`,
      );
      throw new BadRequestException(
        `OpenRouter classification request failed: ${this.getErrorMessage(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildSystemPrompt() {
    return [
      'You classify whether an incoming email is a transport/logistics ORDER request — i.e. a request to arrange pickup and delivery of cargo/goods.',
      'Return JSON that matches the schema exactly.',
      'Set isTransportOrder=true ONLY when the email asks to transport goods (it mentions pickup/delivery/loading/unloading, cargo, addresses, dates, references, etc.).',
      'Set isTransportOrder=false for anything else: newsletters, marketing, invoices/receipts, generic questions, out-of-office replies, spam, account notifications, or unrelated conversations.',
      'reason: one short sentence justifying the decision.',
      'language: ISO-639-1 code of the email language (e.g. nl, en, pt, de).',
      'priority: one of low, normal, high.',
      'When in doubt and the email plausibly concerns transport, prefer isTransportOrder=true (a human can still discard it).',
    ].join('\n');
  }

  private parseModelResponse(
    raw: OpenRouterChatResponse,
  ): OpenRouterModelOutput {
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      try {
        return JSON.parse(content) as OpenRouterModelOutput;
      } catch {
        throw new BadRequestException('OpenRouter returned non-JSON content');
      }
    }
    throw new BadRequestException('OpenRouter returned an empty response');
  }

  private asChatResponse(input: unknown): OpenRouterChatResponse {
    if (typeof input !== 'object' || input === null) {
      throw new BadRequestException('OpenRouter returned an invalid JSON body');
    }
    return input as OpenRouterChatResponse;
  }

  private getErrorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}
