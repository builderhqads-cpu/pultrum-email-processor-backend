import { Injectable } from '@nestjs/common';
import { EmailMessage } from '@prisma/client';
import {
  TransportBookingValidationResult,
  TransportBookingValidationService,
} from '../transport-booking-validation/transport-booking-validation.service';

export type ValidationResult = TransportBookingValidationResult;

@Injectable()
export class RequiredFieldsService {
  constructor(
    private readonly transportBookingValidationService: TransportBookingValidationService,
  ) {}

  validateEmailContent(
    email: EmailMessage,
    combinedText?: string,
    options?: { enqueueJobs?: boolean },
  ): Promise<ValidationResult> {
    return this.transportBookingValidationService.validateEmailContent(
      email,
      combinedText,
      options,
    );
  }
}
