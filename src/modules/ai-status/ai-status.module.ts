import { Module } from '@nestjs/common';
import { AiStatusController } from './ai-status.controller';
import { AiStatusService } from './ai-status.service';

@Module({
  controllers: [AiStatusController],
  providers: [AiStatusService],
})
export class AiStatusModule {}
