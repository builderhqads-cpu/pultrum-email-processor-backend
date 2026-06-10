import { Module } from '@nestjs/common';
import { XmlService } from './xml.service';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';

@Module({
  imports: [TransportBookingValidationModule],
  providers: [XmlService],
  exports: [XmlService],
})
export class XmlModule {}
