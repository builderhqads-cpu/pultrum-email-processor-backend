import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditLogService {
  constructor(private readonly prismaService: PrismaService) {}

  async log(input: {
    entityType: string;
    entityId: string;
    action: string;
    detailsJson?: unknown;
  }) {
    await this.prismaService.auditLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        detailsJson: input.detailsJson as any,
      },
    });
  }
}
