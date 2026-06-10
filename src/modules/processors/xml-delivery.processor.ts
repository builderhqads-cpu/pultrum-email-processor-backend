import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_XML_DELIVERY } from '../queues/queue-names';
import { CreativeGearsService } from '../creative-gears/creative-gears.service';

@Processor(QUEUE_XML_DELIVERY)
export class XmlDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(XmlDeliveryProcessor.name);

  constructor(private readonly creativeGearsService: CreativeGearsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const orderId = job.data?.orderId as string | undefined;
    if (orderId) {
      this.logger.log(
        `Sending XML delivery to Creative Gears: orderId=${orderId}`,
      );
      try {
        await this.creativeGearsService.sendXmlDelivery(orderId);
      } catch (err: any) {
        this.logger.error(
          `XML delivery failed: orderId=${orderId} jobId=${job.id} message=${err?.message ?? String(err)}`,
          err?.stack,
        );
        throw err;
      }
      return;
    }

    this.logger.log(
      `Received job queue=${job.queueName} id=${job.id} name=${job.name} data=${JSON.stringify(job.data)}`,
    );
  }
}
