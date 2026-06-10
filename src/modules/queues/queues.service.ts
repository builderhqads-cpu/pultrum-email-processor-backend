import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QUEUE_AI_REQUEST,
  QUEUE_EMAIL_PROCESSING,
  QUEUE_MAILBOX_SYNC,
  QUEUE_XML_DELIVERY,
} from './queue-names';

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_MAILBOX_SYNC)
    private readonly mailboxSyncQueue: Queue,
    @InjectQueue(QUEUE_EMAIL_PROCESSING)
    private readonly emailProcessingQueue: Queue,
    @InjectQueue(QUEUE_AI_REQUEST)
    private readonly aiRequestQueue: Queue,
    @InjectQueue(QUEUE_XML_DELIVERY)
    private readonly xmlDeliveryQueue: Queue,
  ) {}

  async enqueueTestJobs() {
    const now = new Date().toISOString();

    await Promise.all([
      this.mailboxSyncQueue.add('test', { now, queue: QUEUE_MAILBOX_SYNC }),
      this.emailProcessingQueue.add('test', {
        now,
        queue: QUEUE_EMAIL_PROCESSING,
      }),
      this.aiRequestQueue.add('test', { now, queue: QUEUE_AI_REQUEST }),
      this.xmlDeliveryQueue.add('test', { now, queue: QUEUE_XML_DELIVERY }),
    ]);
  }
}
