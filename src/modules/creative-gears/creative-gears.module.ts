import { Module } from '@nestjs/common';
import { CreativeGearsService } from './creative-gears.service';
import { XmlModule } from '../xml/xml.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [XmlModule, AlertsModule],
  providers: [CreativeGearsService],
  exports: [CreativeGearsService],
})
export class CreativeGearsModule {}
