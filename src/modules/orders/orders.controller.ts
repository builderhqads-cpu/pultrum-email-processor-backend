import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Get(':id/reply-draft')
  @UseGuards(JwtAuthGuard)
  getReplyDraft(@Param('id') id: string) {
    return this.ordersService.getReplyDraft(id);
  }

  @Put(':id/reply-draft')
  @UseGuards(JwtAuthGuard)
  updateReplyDraft(
    @Param('id') id: string,
    @Body() body: { toEmail?: string; subject?: string; body?: string },
  ) {
    return this.ordersService.updateReplyDraft(id, body);
  }

  @Post(':id/send-reply')
  @UseGuards(JwtAuthGuard)
  sendReply(@Param('id') id: string) {
    return this.ordersService.sendReply(id);
  }

  @Post(':id/reprocess')
  @UseGuards(JwtAuthGuard)
  reprocess(@Param('id') id: string) {
    return this.ordersService.reprocess(id);
  }

  @Post(':id/send-xml')
  @UseGuards(JwtAuthGuard)
  sendXml(@Param('id') id: string) {
    return this.ordersService.sendXml(id);
  }

  @Post(':id/send-ai-request')
  @UseGuards(JwtAuthGuard)
  sendAiRequest(@Param('id') id: string) {
    return this.ordersService.sendAiRequest(id);
  }

  @Post(':id/generate-reply-draft')
  @UseGuards(JwtAuthGuard)
  generateReplyDraft(@Param('id') id: string) {
    return this.ordersService.generateReplyDraft(id);
  }

  @Post(':id/generate-ai-reply')
  @UseGuards(JwtAuthGuard)
  generateAiReply(@Param('id') id: string) {
    return this.ordersService.generateAiReply(id);
  }
}
