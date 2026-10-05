import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
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

  @Get(':id/xml-preview')
  @UseGuards(JwtAuthGuard)
  previewXml(@Param('id') id: string) {
    return this.ordersService.previewXml(id);
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

  // Renato 2026-09-28: fresh reprocess — re-extract with the CURRENT customer
  // AI-instruction and OVERWRITE the AI-read fields, so an edited instruction
  // visibly takes effect. Separate route so it's an explicit, deliberate action.
  @Post(':id/reprocess-fresh')
  @UseGuards(JwtAuthGuard)
  reprocessFresh(@Param('id') id: string) {
    return this.ordersService.reprocess(id, true);
  }

  // Renato 2026-09-21: delete a single order so the planner can quickly clear
  // wrongly-processed orders and reprocess the email without stale rows piling up.
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.ordersService.deleteOrder(id);
  }

  @Post(':id/send-xml')
  @UseGuards(JwtAuthGuard)
  sendXml(@Param('id') id: string) {
    return this.ordersService.sendXml(id);
  }

  // Renato 2026-10-05 (QoL): manually correct one field value in the portal.
  @Patch(':id/fields/:key')
  @UseGuards(JwtAuthGuard)
  updateField(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() body: { value?: string },
  ) {
    return this.ordersService.updateOrderFieldValue(id, key, body?.value ?? '');
  }

  // Niek: include/exclude one document (attachment id, or "email" for the .eml)
  // from THIS order's XML during the conference — reversible, without deleting.
  @Put(':id/documents/:documentId')
  @UseGuards(JwtAuthGuard)
  setDocumentExcluded(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: { excluded?: boolean },
  ) {
    return this.ordersService.setOrderDocumentExcluded(
      id,
      documentId,
      Boolean(body?.excluded),
    );
  }

  // Niek 2026-09-11: force send — deliver even with required fields missing
  // (customer_id still required). Separate route so it's an explicit action.
  @Post(':id/force-send-xml')
  @UseGuards(JwtAuthGuard)
  forceSendXml(@Param('id') id: string) {
    return this.ordersService.sendXml(id, true);
  }

  // Niek: send the XML for a whole batch at once.
  @Post('batch/:batchImportId/send-xml')
  @UseGuards(JwtAuthGuard)
  sendBatchXml(@Param('batchImportId') batchImportId: string) {
    return this.ordersService.sendBatchXml(batchImportId);
  }

  // Niek 2026-09-11: force send the whole batch (missing fields ignored per
  // order; customer_id still required).
  @Post('batch/:batchImportId/force-send-xml')
  @UseGuards(JwtAuthGuard)
  forceSendBatchXml(@Param('batchImportId') batchImportId: string) {
    return this.ordersService.sendBatchXml(batchImportId, true);
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
