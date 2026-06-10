import { Module } from '@nestjs/common';
import { ThreadLinkingService } from './thread-linking.service';
import { EmailContextMapperService } from './email-context-mapper.service';

@Module({
  providers: [ThreadLinkingService, EmailContextMapperService],
  exports: [ThreadLinkingService, EmailContextMapperService],
})
export class ThreadLinkingModule {}
