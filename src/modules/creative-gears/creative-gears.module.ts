import { Module } from '@nestjs/common';
import { CreativeGearsService } from './creative-gears.service';
import { XmlModule } from '../xml/xml.module';
import { AlertsModule } from '../alerts/alerts.module';
import { EmailSenderModule } from '../email-sender/email-sender.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  imports: [XmlModule, AlertsModule, EmailSenderModule, SystemSettingsModule],
  providers: [CreativeGearsService],
  exports: [CreativeGearsService],
})
export class CreativeGearsModule {}
