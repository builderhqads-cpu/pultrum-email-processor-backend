import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiStatusService } from './ai-status.service';

@Controller('ai-status')
@UseGuards(JwtAuthGuard)
export class AiStatusController {
  constructor(private readonly aiStatusService: AiStatusService) {}

  @Get()
  getStatus() {
    return this.aiStatusService.getStatus();
  }
}
