import { Module } from '@nestjs/common';
import { ProcessorsService } from './processors.service';
import { QueuesModule } from '../queues/queues.module';
import { RequiredFieldsModule } from '../required-fields/required-fields.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AiClientModule } from '../ai-client/ai-client.module';
import { CreativeGearsModule } from '../creative-gears/creative-gears.module';
import { GraphModule } from '../graph/graph.module';
import { AttachmentParserModule } from '../attachment-parser/attachment-parser.module';
import { OrderClassifierModule } from '../order-classifier/order-classifier.module';
import { MailboxSyncProcessor } from './mailbox-sync.processor';
import { EmailProcessingProcessor } from './email-processing.processor';
import { AiRequestProcessor } from './ai-request.processor';
import { XmlDeliveryProcessor } from './xml-delivery.processor';
import { ThreadLinkingModule } from '../thread-linking/thread-linking.module';
import { AiExtractionModule } from '../ai-extraction/ai-extraction.module';
import { AiClassificationModule } from '../ai-classification/ai-classification.module';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';
import { ClientProfileModule } from '../client-profiles/client-profile.module';
import { OrderSplitModule } from '../order-split/order-split.module';
import { AiReplyModule } from '../ai-reply/ai-reply.module';
import { FieldMergeService } from '../field-merge/field-merge.service';
import { GeocodingModule } from '../geocoding/geocoding.module';

@Module({
  imports: [
    QueuesModule,
    RequiredFieldsModule,
    AuditLogModule,
    AiClientModule,
    AiExtractionModule,
    AiClassificationModule,
    CreativeGearsModule,
    GraphModule,
    AttachmentParserModule,
    OrderClassifierModule,
    ThreadLinkingModule,
    TransportBookingValidationModule,
    ClientProfileModule,
    OrderSplitModule,
    AiReplyModule,
    GeocodingModule,
  ],
  providers: [
    ProcessorsService,
    FieldMergeService,
    MailboxSyncProcessor,
    EmailProcessingProcessor,
    AiRequestProcessor,
    XmlDeliveryProcessor,
  ],
  exports: [ProcessorsService],
})
export class ProcessorsModule {}
