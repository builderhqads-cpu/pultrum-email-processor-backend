import { Module } from '@nestjs/common';
import { ExtractionPipelineService } from './extraction-pipeline.service';
import { AttachmentParserModule } from '../attachment-parser/attachment-parser.module';
import { AiExtractionModule } from '../ai-extraction/ai-extraction.module';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';
import { LabelParserService } from '../label-parser/label-parser.service';
import { RegexExtractionService } from '../regex-extraction/regex-extraction.service';
import { FieldMergeService } from '../field-merge/field-merge.service';

@Module({
  imports: [AttachmentParserModule, AiExtractionModule, TransportBookingValidationModule],
  providers: [
    ExtractionPipelineService,
    LabelParserService,
    RegexExtractionService,
    FieldMergeService,
  ],
  exports: [ExtractionPipelineService],
})
export class ExtractionPipelineModule {}
