import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { EmailsService } from './emails.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('emails')
@UseGuards(JwtAuthGuard)
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @Get()
  findAll() {
    return this.emailsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.emailsService.findOne(id);
  }

  @Get(':id/original')
  findOriginal(@Param('id') id: string) {
    return this.emailsService.findOriginal(id);
  }

  // Renato 2026-10-07: download the raw .eml of an email.
  @Get(':id/eml')
  async downloadEml(@Param('id') id: string) {
    const { buffer, filename } = await this.emailsService.getEmlFile(id);
    return new StreamableFile(buffer, {
      type: 'message/rfc822',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post(':id/reclassify')
  reclassify(@Param('id') id: string) {
    return this.emailsService.reclassify(id);
  }

  @Post(':id/process-anyway')
  processAnyway(@Param('id') id: string) {
    return this.emailsService.processAnyway(id);
  }

  // Bulk delete: DELETE /emails (distinct path from DELETE /emails/:id).
  @Delete()
  removeAll() {
    return this.emailsService.removeAll();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.emailsService.remove(id);
  }
}
