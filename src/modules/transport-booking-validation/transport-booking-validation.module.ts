import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TransportBookingValidationService } from './transport-booking-validation.service';

@Module({
  imports: [QueuesModule, SystemSettingsModule],
  providers: [TransportBookingValidationService],
  exports: [TransportBookingValidationService],
})
export class TransportBookingValidationModule {}

