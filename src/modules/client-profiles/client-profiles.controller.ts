import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientProfileService } from './client-profile.service';

type CustomerProfilePayload = {
  name?: unknown;
  contactEmail?: unknown;
  additionalContactEmails?: unknown;
  active?: unknown;
  notes?: unknown;
  fields?: unknown;
};

@Controller('customer-profiles')
@UseGuards(JwtAuthGuard)
export class ClientProfilesController {
  constructor(private readonly clientProfileService: ClientProfileService) {}

  @Get('field-catalog')
  getFieldCatalog() {
    return this.clientProfileService.getFieldCatalog();
  }

  @Get()
  findAll() {
    return this.clientProfileService.listCustomerProfiles();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.clientProfileService.getCustomerProfile(id);
  }

  @Post()
  create(@Body() body: CustomerProfilePayload) {
    const input = this.clientProfileService.normalizeMutationInput(body ?? {});
    return this.clientProfileService.createCustomerProfile(input);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: CustomerProfilePayload) {
    const input = this.clientProfileService.normalizePartialMutationInput(
      body ?? {},
    );
    return this.clientProfileService.updateCustomerProfile(id, input);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.clientProfileService.deleteCustomerProfile(id);
  }
}
