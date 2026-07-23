import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
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

  @Post(':id/reclassify')
  reclassify(@Param('id') id: string) {
    return this.emailsService.reclassify(id);
  }

  @Post(':id/process-anyway')
  processAnyway(@Param('id') id: string) {
    return this.emailsService.processAnyway(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.emailsService.remove(id);
  }
}
