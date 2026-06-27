import { Module } from '@nestjs/common';
import { ClientProfileModule } from '../client-profiles/client-profile.module';
import { OpenRouterSplitService } from './openrouter-split.service';
import { OrderSplitService } from './order-split.service';

@Module({
  imports: [ClientProfileModule],
  providers: [OpenRouterSplitService, OrderSplitService],
  exports: [OrderSplitService],
})
export class OrderSplitModule {}
