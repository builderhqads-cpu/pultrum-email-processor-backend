import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  SystemSettingsService,
  type UpdateAutomationDto,
} from './system-settings.service';

@Controller('settings/automation')
@UseGuards(JwtAuthGuard)
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  get() {
    return this.systemSettingsService.get();
  }

  @Patch()
  update(@Body() body: UpdateAutomationDto) {
    return this.systemSettingsService.update(body ?? {});
  }
}
