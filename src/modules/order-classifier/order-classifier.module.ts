import { Module } from '@nestjs/common';
import { OrderClassifierService } from './order-classifier.service';

@Module({
  providers: [OrderClassifierService],
  exports: [OrderClassifierService],
})
export class OrderClassifierModule {}
