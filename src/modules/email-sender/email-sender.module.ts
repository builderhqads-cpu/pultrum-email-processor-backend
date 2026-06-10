import { Module } from '@nestjs/common';
import { EmailSenderService } from './email-sender.service';
import { GraphModule } from '../graph/graph.module';

@Module({
  imports: [GraphModule],
  providers: [EmailSenderService],
  exports: [EmailSenderService],
})
export class EmailSenderModule {}
