import { Module } from '@nestjs/common';
import { RequiredFieldsService } from './required-fields.service';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';

@Module({
  imports: [TransportBookingValidationModule],
  providers: [RequiredFieldsService],
  exports: [RequiredFieldsService],
})
export class RequiredFieldsModule {}
