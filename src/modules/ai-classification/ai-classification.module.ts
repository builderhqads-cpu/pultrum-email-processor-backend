import { Module } from '@nestjs/common';
import { AiClassificationService } from './ai-classification.service';
import { OpenRouterClassificationService } from './openrouter-classification.service';
import { OpenRouterClassificationController } from './openrouter-classification.controller';

@Module({
  controllers: [OpenRouterClassificationController],
  providers: [AiClassificationService, OpenRouterClassificationService],
  exports: [AiClassificationService],
})
export class AiClassificationModule {}
