import { Body, Controller, Post } from '@nestjs/common';
import type { AiExtractionPayload } from './ai-extraction.service';
import { OpenRouterExtractionService } from './openrouter-extraction.service';

@Controller('ai-test')
export class OpenRouterExtractionController {
  constructor(
    private readonly openRouterExtractionService: OpenRouterExtractionService,
  ) {}

  @Post('extract-transport-order')
  extractTransportOrder(@Body() body: AiExtractionPayload) {
    return this.openRouterExtractionService.extractTransportOrder(body);
  }
}
