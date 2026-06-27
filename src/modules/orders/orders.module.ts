import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { QueuesModule } from '../queues/queues.module';
import { EmailSenderModule } from '../email-sender/email-sender.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AiClientModule } from '../ai-client/ai-client.module';
import { ExtractionPipelineModule } from '../extraction-pipeline/extraction-pipeline.module';
import { AiExtractionModule } from '../ai-extraction/ai-extraction.module';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';
import { AiReplyModule } from '../ai-reply/ai-reply.module';
import { XmlModule } from '../xml/xml.module';
import { ClientProfileModule } from '../client-profiles/client-profile.module';

@Module({
  imports: [
    QueuesModule,
    EmailSenderModule,
    AuditLogModule,
    AiClientModule,
    ExtractionPipelineModule,
    AiExtractionModule,
    TransportBookingValidationModule,
    AiReplyModule,
    XmlModule,
    ClientProfileModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
