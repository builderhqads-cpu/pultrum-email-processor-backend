import { Module } from '@nestjs/common';
import { CgStatusController } from './cg-status.controller';
import { CgStatusService } from './cg-status.service';

@Module({
  controllers: [CgStatusController],
  providers: [CgStatusService],
})
export class CgStatusModule {}
