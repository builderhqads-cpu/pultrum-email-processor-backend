import { Module } from '@nestjs/common';
import { ClientProfileService } from './client-profile.service';
import { ClientProfilesController } from './client-profiles.controller';

@Module({
  controllers: [ClientProfilesController],
  providers: [ClientProfileService],
  exports: [ClientProfileService],
})
export class ClientProfileModule {}
