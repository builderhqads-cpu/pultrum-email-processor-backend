import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphAuthService } from './graph-auth.service';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { NormalizedAttachment } from '../../mail/providers/mail-provider.interface';

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(
    private readonly graphAuthService: GraphAuthService,
    private readonly configService: ConfigService,
  ) {}

  async getRecentMessages(mailboxEmail: string, top = 10) {
    const client = await this.graphAuthService.getAuthenticatedClient(
      mailboxEmail,
    );

    const response = await client
      .api(
        `/users/${encodeURIComponent(mailboxEmail)}/mailFolders/inbox/messages`,
      )
      .top(top)
      .orderby('receivedDateTime desc')
      .select(
        'id,conversationId,from,subject,bodyPreview,body,receivedDateTime,hasAttachments',
      )
      .get();

    return response?.value ?? [];
  }

  async getMessageAttachments(
    mailboxEmail: string,
    messageId: string,
  ): Promise<NormalizedAttachment[]> {
    const client = await this.graphAuthService.getAuthenticatedClient(
      mailboxEmail,
    );

    const mailbox = encodeURIComponent(mailboxEmail);
    const msg = encodeURIComponent(messageId);

    const listResponse = await client
      .api(`/users/${mailbox}/messages/${msg}/attachments`)
      // NOTE: do NOT select 'contentId' here — like 'contentBytes', it only
      // exists on the derived type microsoft.graph.fileAttachment, so selecting
      // it on the base attachment collection fails with a 400 and we'd download
      // NO attachments. We read contentId from the per-attachment detail GET.
      .select('id,name,contentType,size,isInline')
      .get();

    const items = (listResponse?.value ?? []) as Array<any>;
    if (!items.length) return [];

    // Max attachment size to download/extract. Real transport documents (DOCX
    // with route maps, multi-page PDFs) easily exceed 1 MiB, so default to 15.
    const maxMb =
      Number(this.configService.get<string>('ATTACHMENT_MAX_MB') || '15') || 15;
    const maxBase64Bytes = maxMb * 1024 * 1024;

    const results: NormalizedAttachment[] = [];

    for (const att of items) {
      const id = (att?.id ?? '').toString();
      if (!id) continue;

      const name = (att?.name ?? '').toString() || `attachment-${id}`;
      const contentType = (att?.contentType ?? '').toString() || undefined;

      const isImage = (contentType || '').toLowerCase().startsWith('image/');

      // Fast path: an image explicitly marked inline is a body image (signature
      // logo, social icon) — skip without downloading anything.
      if (isImage && att?.isInline === true) {
        continue;
      }

      const size =
        typeof att?.size === 'number'
          ? att.size
          : Number(att?.size ?? 0) || undefined;
      let contentBase64: string | undefined;
      let contentId: string | undefined;

      if (size && size > 0 && size <= maxBase64Bytes) {
        try {
          // NOTE: do NOT .select('contentBytes') — it only exists on the
          // derived type microsoft.graph.fileAttachment, so selecting it on the
          // base attachment type fails ("Could not find a property named
          // 'contentBytes'"). A plain GET returns the full fileAttachment with
          // contentBytes (and contentId) included.
          const details = await client
            .api(
              `/users/${mailbox}/messages/${msg}/attachments/${encodeURIComponent(id)}`,
            )
            .get();

          contentId = (details?.contentId ?? '').toString().trim() || undefined;
          const bytes = details?.contentBytes;
          if (typeof bytes === 'string' && bytes.trim()) {
            contentBase64 = bytes.trim();
          } else {
            // Fallback: download raw bytes for file/item attachments.
            const buf = (await client
              .api(
                `/users/${mailbox}/messages/${msg}/attachments/${encodeURIComponent(id)}/$value`,
              )
              .responseType(ResponseType.ARRAYBUFFER)
              .get()) as ArrayBuffer;

            contentBase64 = Buffer.from(buf).toString('base64');
          }
        } catch (err: any) {
          // Best-effort: keep metadata even if content download fails, but
          // surface WHY so a missing attachment body can be diagnosed.
          this.logger.warn(
            `Graph attachment content download failed messageId=${messageId} attachmentId=${id} name=${name}: ${err?.message ?? err}`,
          );
          contentBase64 = undefined;
        }
      } else if (size && size > maxBase64Bytes) {
        this.logger.warn(
          `Graph attachment skipped (too large) messageId=${messageId} attachmentId=${id} name=${name} size=${size}`,
        );
      }

      // Graph's isInline is unreliable for server-stamped signatures (Exclaimer
      // arrives with isInline=false). A body-embedded image ALWAYS carries a
      // Content-ID (referenced via cid: in the HTML); a real attached image
      // (photo/scan) does not. Drop the former, keep the latter.
      if (isImage && contentId) {
        continue;
      }

      results.push({
        providerAttachmentId: id,
        fileName: name,
        mimeType: contentType,
        size,
        contentBase64,
      });
    }

    return results;
  }
}
