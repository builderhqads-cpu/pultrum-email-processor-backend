import { Module } from '@nestjs/common';
import { AttachmentExtractionService } from './attachment-extraction.service';
import { OcrModule } from '../ocr/ocr.module';

@Module({
  imports: [OcrModule],
  providers: [AttachmentExtractionService],
  exports: [AttachmentExtractionService],
})
export class AttachmentExtractionModule {}
