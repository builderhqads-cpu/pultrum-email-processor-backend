import { Module } from '@nestjs/common';
import { EmailSenderModule } from '../email-sender/email-sender.module';
import { AlertsService } from './alerts.service';

@Module({
  imports: [EmailSenderModule],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
