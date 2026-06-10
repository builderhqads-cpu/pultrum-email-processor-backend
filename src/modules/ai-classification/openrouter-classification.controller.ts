import { Body, Controller, Post } from '@nestjs/common';
import type { AiClassificationPayload } from './ai-classification.service';
import { OpenRouterClassificationService } from './openrouter-classification.service';

@Controller('ai-test')
export class OpenRouterClassificationController {
  constructor(
    private readonly openRouterClassificationService: OpenRouterClassificationService,
  ) {}

  @Post('classify-email')
  classifyEmail(@Body() body: AiClassificationPayload) {
    return this.openRouterClassificationService.classifyEmail(body);
  }
}
