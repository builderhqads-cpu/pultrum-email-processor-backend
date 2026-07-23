import { Module } from '@nestjs/common';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { EmailOriginalService } from './email-original.service';

@Module({
  controllers: [EmailsController],
  providers: [EmailsService, EmailOriginalService],
  exports: [EmailsService],
})
export class EmailsModule {}
