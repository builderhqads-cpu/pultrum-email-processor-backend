import { Module } from '@nestjs/common';
import { AiReplyService } from './ai-reply.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { OpenRouterReplyService } from './openrouter-reply.service';
import { OpenRouterReplyController } from './openrouter-reply.controller';

@Module({
  imports: [AuditLogModule],
  controllers: [OpenRouterReplyController],
  providers: [AiReplyService, OpenRouterReplyService],
  exports: [AiReplyService],
})
export class AiReplyModule {}
