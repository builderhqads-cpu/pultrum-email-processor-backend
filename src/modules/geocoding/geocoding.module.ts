import { Module } from '@nestjs/common';
import { RegexExtractionService } from '../regex-extraction/regex-extraction.service';
import { TransportBookingValidationModule } from '../transport-booking-validation/transport-booking-validation.module';
import { AddressEnrichmentService } from './address-enrichment.service';
import { GoogleGeocodingService } from './google-geocoding.service';

@Module({
  imports: [TransportBookingValidationModule],
  providers: [
    RegexExtractionService,
    GoogleGeocodingService,
    AddressEnrichmentService,
  ],
  exports: [AddressEnrichmentService],
})
export class GeocodingModule {}
