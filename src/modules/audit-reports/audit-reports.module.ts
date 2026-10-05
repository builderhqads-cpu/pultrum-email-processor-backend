import { Module } from '@nestjs/common';

import { AuditReportsController } from './audit-reports.controller';
import { AuditReportsService } from './audit-reports.service';
import { RenovoAdminGuard } from './renovo-admin.guard';

@Module({
  controllers: [AuditReportsController],
  providers: [AuditReportsService, RenovoAdminGuard],
})
export class AuditReportsModule {}
