import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Get(':id/reply-draft')
  getReplyDraft(@Param('id') id: string) {
    return this.ordersService.getReplyDraft(id);
  }

  @Put(':id/reply-draft')
  updateReplyDraft(
    @Param('id') id: string,
    @Body() body: { toEmail?: string; subject?: string; body?: string },
  ) {
    return this.ordersService.updateReplyDraft(id, body);
  }

  @Post(':id/send-reply')
  sendReply(@Param('id') id: string) {
    return this.ordersService.sendReply(id);
  }

  @Post(':id/reprocess')
  reprocess(@Param('id') id: string) {
    return this.ordersService.reprocess(id);
  }

  @Post(':id/send-xml')
  sendXml(@Param('id') id: string) {
    return this.ordersService.sendXml(id);
  }

  @Get(':id/xml-preview')
  previewXml(@Param('id') id: string) {
    return this.ordersService.previewXml(id);
  }

  @Post(':id/send-ai-request')
  sendAiRequest(@Param('id') id: string) {
    return this.ordersService.sendAiRequest(id);
  }

  @Post(':id/process-with-ai')
  processWithAi(@Param('id') id: string) {
    return this.ordersService.processWithAi(id);
  }

  @Post(':id/generate-reply-draft')
  generateReplyDraft(@Param('id') id: string) {
    return this.ordersService.generateReplyDraft(id);
  }

  @Post(':id/generate-ai-reply')
  generateAiReply(@Param('id') id: string) {
    return this.ordersService.generateAiReply(id);
  }
}
