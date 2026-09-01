import { Module } from '@nestjs/common';
import { DoclingService } from './docling.service';

@Module({
  providers: [DoclingService],
  exports: [DoclingService],
})
export class DoclingModule {}
