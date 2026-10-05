import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RenovoAdminGuard } from './renovo-admin.guard';
import { AuditReportsService, type GroupBy } from './audit-reports.service';

function normalizeGroupBy(value?: string): GroupBy {
  return value === 'customer' ||
    value === 'model' ||
    value === 'day_customer'
    ? value
    : 'day';
}

@Controller('audit')
@UseGuards(JwtAuthGuard, RenovoAdminGuard)
export class AuditReportsController {
  constructor(private readonly auditReportsService: AuditReportsService) {}

  @Get('email-stats')
  async emailStats(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('groupBy') groupBy: string | undefined,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auditReportsService.emailStats({
      from,
      to,
      groupBy: normalizeGroupBy(groupBy),
    });

    if ((format || '').toLowerCase() === 'csv') {
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="email-stats-${result.groupBy}-${stamp}.csv"`,
      );
      return this.auditReportsService.toCsv(result);
    }

    return result;
  }
}
