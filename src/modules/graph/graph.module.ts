import { Module } from '@nestjs/common';
import { GraphService } from './graph.service';
import { GraphAuthService } from './graph-auth.service';

@Module({
  providers: [GraphService, GraphAuthService],
  exports: [GraphService, GraphAuthService],
})
export class GraphModule {}
