import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_MAILBOX_SYNC } from '../queues/queue-names';

@Processor(QUEUE_MAILBOX_SYNC)
export class MailboxSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(MailboxSyncProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Received job queue=${job.queueName} id=${job.id} name=${job.name} data=${JSON.stringify(job.data)}`,
    );
  }
}
