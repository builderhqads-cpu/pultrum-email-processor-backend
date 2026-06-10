import { Controller, Post, UseGuards } from '@nestjs/common';
import { QueuesService } from './queues.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('queues')
@UseGuards(JwtAuthGuard)
export class QueuesController {
  constructor(private readonly queuesService: QueuesService) {}

  @Post('test')
  async testQueues() {
    await this.queuesService.enqueueTestJobs();
    return { ok: true };
  }
}
