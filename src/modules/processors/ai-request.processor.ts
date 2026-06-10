import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_AI_REQUEST } from '../queues/queue-names';
import { AiClientService } from '../ai-client/ai-client.service';

@Processor(QUEUE_AI_REQUEST)
export class AiRequestProcessor extends WorkerHost {
  private readonly logger = new Logger(AiRequestProcessor.name);

  constructor(private readonly aiClientService: AiClientService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const orderId = job.data?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(
        `Job missing orderId: id=${job.id} data=${JSON.stringify(job.data)}`,
      );
      return;
    }

    this.logger.log(
      `Processing ai-request: queue=${job.queueName} id=${job.id} orderId=${orderId}`,
    );

    await this.aiClientService.sendMissingInfoRequest(orderId);
  }
}
