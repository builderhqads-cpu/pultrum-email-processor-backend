import { Module } from '@nestjs/common';
import { AiExtractionService } from './ai-extraction.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { OpenRouterExtractionService } from './openrouter-extraction.service';
import { OpenRouterExtractionController } from './openrouter-extraction.controller';
import { GeocodingModule } from '../geocoding/geocoding.module';

@Module({
  imports: [AuditLogModule, GeocodingModule],
  controllers: [OpenRouterExtractionController],
  providers: [AiExtractionService, OpenRouterExtractionService],
  exports: [AiExtractionService],
})
export class AiExtractionModule {}
