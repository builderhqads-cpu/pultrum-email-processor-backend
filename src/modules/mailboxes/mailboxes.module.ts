import { Module } from '@nestjs/common';
import { MailboxesService } from './mailboxes.service';
import { MailboxesController } from './mailboxes.controller';
import { MailSyncService } from './mail-sync.service';
import { GraphModule } from '../graph/graph.module';
import { QueuesModule } from '../queues/queues.module';
import { MailProviderFactory } from '../../mail/mail-provider.factory';
import { MailboxController } from './mailbox.controller';
import { MailboxSyncScheduler } from './mailbox-sync.scheduler';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  imports: [GraphModule, QueuesModule, SystemSettingsModule],
  controllers: [MailboxesController, MailboxController],
  providers: [
    MailboxesService,
    MailSyncService,
    MailProviderFactory,
    MailboxSyncScheduler,
  ],
  exports: [MailboxesService],
})
export class MailboxesModule {}
