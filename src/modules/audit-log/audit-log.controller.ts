import { Controller, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('audit-log')
@UseGuards(JwtAuthGuard)
export class AuditLogController {}
