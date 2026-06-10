import { Body, Controller, Post } from '@nestjs/common';
import { OpenRouterReplyService } from './openrouter-reply.service';

@Controller('ai-test')
export class OpenRouterReplyController {
  constructor(
    private readonly openRouterReplyService: OpenRouterReplyService,
  ) {}

  @Post('generate-missing-info-reply')
  generateMissingInfoReply(@Body() body: Record<string, unknown>) {
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';

    return this.openRouterReplyService.generateMissingInfoReply({
      orderId,
      department: typeof body.department === 'string' ? body.department : null,
      customerEmail:
        typeof body.customerEmail === 'string' ? body.customerEmail : null,
      subject: typeof body.subject === 'string' ? body.subject : null,
      bodyText: typeof body.bodyText === 'string' ? body.bodyText : null,
      detectedFields: Array.isArray(body.detectedFields)
        ? (body.detectedFields as Array<{
            key: string;
            label: string;
            value: string | null;
            confidence?: number | null;
            source?: string | null;
          }>)
        : [],
      missingFields: Array.isArray(body.missingFields)
        ? (body.missingFields as Array<{
            key: string;
            label: string;
            reason?: string | null;
          }>)
        : [],
      validationWarnings: Array.isArray(body.validationWarnings)
        ? (body.validationWarnings as Array<{
            key: string;
            label: string;
            reason?: string | null;
          }>)
        : [],
      language: typeof body.language === 'string' ? body.language : null,
      replyToken: typeof body.replyToken === 'string' ? body.replyToken : null,
    });
  }
}
