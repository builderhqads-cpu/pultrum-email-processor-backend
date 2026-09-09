import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CgStatusService } from './cg-status.service';

@Controller('cg-status')
@UseGuards(JwtAuthGuard)
export class CgStatusController {
  constructor(private readonly cgStatusService: CgStatusService) {}

  @Get()
  getStatus() {
    return this.cgStatusService.getStatus();
  }
}
