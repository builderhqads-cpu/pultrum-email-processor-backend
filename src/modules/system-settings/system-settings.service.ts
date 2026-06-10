import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const SETTINGS_ID = 'default';

const SYNC_MODES = ['MANUAL', 'AUTOMATIC'] as const;
const DELIVERY_MODES = ['MANUAL', 'SELECTIVE', 'AUTONOMOUS'] as const;

export type UpdateAutomationDto = {
  syncMode?: string;
  deliveryMode?: string;
  autoXmlConfidenceThreshold?: number;
};

@Injectable()
export class SystemSettingsService {
  constructor(private readonly prismaService: PrismaService) {}

  /** Reads the singleton settings row, creating it with defaults if missing. */
  async get() {
    return this.prismaService.systemSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async update(dto: UpdateAutomationDto) {
    const data: UpdateAutomationDto = {};

    if (dto.syncMode !== undefined) {
      if (!(SYNC_MODES as readonly string[]).includes(dto.syncMode)) {
        throw new BadRequestException(
          `Invalid syncMode. Allowed: ${SYNC_MODES.join(', ')}`,
        );
      }
      data.syncMode = dto.syncMode;
    }

    if (dto.deliveryMode !== undefined) {
      if (!(DELIVERY_MODES as readonly string[]).includes(dto.deliveryMode)) {
        throw new BadRequestException(
          `Invalid deliveryMode. Allowed: ${DELIVERY_MODES.join(', ')}`,
        );
      }
      data.deliveryMode = dto.deliveryMode;
    }

    if (dto.autoXmlConfidenceThreshold !== undefined) {
      const value = Number(dto.autoXmlConfidenceThreshold);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new BadRequestException(
          'autoXmlConfidenceThreshold must be a number between 0 and 1',
        );
      }
      data.autoXmlConfidenceThreshold = value;
    }

    return this.prismaService.systemSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: data,
    });
  }

  async isAutoSyncEnabled() {
    try {
      const settings = await this.get();
      return settings.syncMode === 'AUTOMATIC';
    } catch {
      // Safe default (e.g. before the migration is applied): no auto-sync.
      return false;
    }
  }

  /**
   * Whether a completed order may be delivered to Creative Gears automatically,
   * based on the current operation mode. MANUAL never auto-delivers; SELECTIVE
   * only when confidence meets the threshold; AUTONOMOUS always. Any error
   * (e.g. settings table not migrated yet) falls back to MANUAL, so the system
   * never auto-sends to Creative Gears by accident.
   */
  async shouldAutoDeliver(overallConfidence: number | null | undefined) {
    try {
      const settings = await this.get();

      if (settings.deliveryMode === 'AUTONOMOUS') return true;
      if (settings.deliveryMode === 'SELECTIVE') {
        return (
          typeof overallConfidence === 'number' &&
          overallConfidence >= settings.autoXmlConfidenceThreshold
        );
      }
      return false; // MANUAL
    } catch {
      return false;
    }
  }
}
