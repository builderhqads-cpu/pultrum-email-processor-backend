import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import {
  QUEUE_AI_REQUEST,
  QUEUE_EMAIL_PROCESSING,
  QUEUE_MAILBOX_SYNC,
  QUEUE_XML_DELIVERY,
} from './queue-names';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: Number(configService.get('REDIS_PORT', 6379)),
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_MAILBOX_SYNC },
      { name: QUEUE_EMAIL_PROCESSING },
      { name: QUEUE_AI_REQUEST },
      { name: QUEUE_XML_DELIVERY },
    ),
  ],
  controllers: [QueuesController],
  providers: [QueuesService],
  exports: [BullModule, QueuesService],
})
export class QueuesModule {}
