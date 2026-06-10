import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OcrService } from './ocr.service';
import { OpenRouterOcrService } from './openrouter-ocr.service';

@Module({
  imports: [ConfigModule],
  providers: [OcrService, OpenRouterOcrService],
  exports: [OcrService],
})
export class OcrModule {}

