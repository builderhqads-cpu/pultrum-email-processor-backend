import { Module } from '@nestjs/common';
import { AttachmentParserService } from './attachment-parser.service';
import { AttachmentExtractionModule } from '../attachment-extraction/attachment-extraction.module';

@Module({
  imports: [AttachmentExtractionModule],
  providers: [AttachmentParserService],
  exports: [AttachmentParserService],
})
export class AttachmentParserModule {}
