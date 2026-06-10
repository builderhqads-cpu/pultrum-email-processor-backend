import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AttachmentExtractionService } from '../attachment-extraction/attachment-extraction.service';
import { AttachmentExtractionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AttachmentParserService {
  private readonly logger = new Logger(AttachmentParserService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly attachmentExtractionService: AttachmentExtractionService,
  ) {}

  async extractTextFromAttachment(attachmentId: string) {
    const attachment = await this.prismaService.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        contentBase64: true,
        extractedText: true,
        extractionMethod: true,
        extractionStatus: true,
      },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment not found: id=${attachmentId}`);
    }

    if (
      attachment.extractionStatus === AttachmentExtractionStatus.SUCCESS &&
      attachment.extractedText &&
      attachment.extractedText.trim()
    ) {
      return attachment.extractedText;
    }

    if (!attachment.contentBase64) {
      await this.prismaService.attachment.update({
        where: { id: attachmentId },
        data: {
          extractedText: null,
          extractionMethod: attachment.extractionMethod ?? null,
          extractionStatus: AttachmentExtractionStatus.FAILED,
        },
      });
      return null;
    }

    await this.prismaService.attachment.update({
      where: { id: attachmentId },
      data: {
        extractionStatus: AttachmentExtractionStatus.PENDING,
      },
    });

    const result = await this.attachmentExtractionService.extractFromBase64({
      attachmentId,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      contentBase64: attachment.contentBase64,
    });

    await this.prismaService.attachment.update({
      where: { id: attachmentId },
      data: {
        extractedText: result.extractedText,
        extractionMethod: result.extractionMethod,
        extractionStatus: result.extractionStatus,
      },
    });

    if (result.extractionStatus === AttachmentExtractionStatus.FAILED) {
      this.logger.warn(
        `Attachment extraction FAILED attachmentId=${attachmentId} fileName=${attachment.fileName} method=${result.extractionMethod}`,
      );
    }

    if (result.extractionStatus === AttachmentExtractionStatus.OCR_REQUIRED) {
      this.logger.warn(
        `Attachment extraction OCR_REQUIRED attachmentId=${attachmentId} fileName=${attachment.fileName} method=${result.extractionMethod}`,
      );
    }

    return result.extractedText;
  }
}
