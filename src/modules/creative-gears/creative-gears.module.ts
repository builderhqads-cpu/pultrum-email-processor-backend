import { Module } from '@nestjs/common';
import { CreativeGearsService } from './creative-gears.service';
import { XmlModule } from '../xml/xml.module';

@Module({
  imports: [XmlModule],
  providers: [CreativeGearsService],
  exports: [CreativeGearsService],
})
export class CreativeGearsModule {}
