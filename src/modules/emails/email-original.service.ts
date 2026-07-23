import { Injectable, Logger } from '@nestjs/common';
import { simpleParser } from 'mailparser';

export type EmailOriginalResult = {
  /** Self-contained HTML: embedded (cid:) images inlined as data URIs. */
  html: string;
  /** True when the body still references images that load from the internet. */
  hasRemoteImages: boolean;
  /** How the body was reconstructed, for the UI to explain what it shows. */
  source: 'html' | 'text' | 'empty';
};

const REMOTE_IMG_SRC_RE =
  /<img\b[^>]*\bsrc\s*=\s*["']\s*https?:\/\//i;

const CID_URL_RE = /(["'(]\s*)cid:([^"')\s>]+)/gi;

@Injectable()
export class EmailOriginalService {
  private readonly logger = new Logger(EmailOriginalService.name);

  /**
   * Rebuild the email as it arrived in the inbox: the HTML body with its
   * embedded signature images resolved (cid: -> data:). Remote images are left
   * as-is but reported, so the UI can block them by default (tracking pixels).
   *
   * Falls back to plain text (escaped, in a <pre>) when there is no HTML, so the
   * caller always gets something renderable.
   */
  async render(input: {
    rawMimeBase64?: string | null;
    bodyHtml?: string | null;
    bodyText?: string | null;
  }): Promise<EmailOriginalResult> {
    let html = (input.bodyHtml ?? '').toString();
    let cidMap = new Map<string, string>();

    if (input.rawMimeBase64) {
      try {
        const parsed = await simpleParser(
          Buffer.from(input.rawMimeBase64, 'base64'),
        );
        if (typeof parsed.html === 'string' && parsed.html.trim()) {
          html = parsed.html;
        } else if (!html && typeof parsed.text === 'string') {
          html = '';
          input = { ...input, bodyText: parsed.text };
        }
        cidMap = this.buildCidMap(parsed.attachments ?? []);
      } catch (err: any) {
        this.logger.warn(`Failed to parse .eml: ${err?.message ?? err}`);
      }
    }

    if (html.trim()) {
      const inlined = this.inlineCidImages(html, cidMap);
      return {
        html: inlined,
        hasRemoteImages: REMOTE_IMG_SRC_RE.test(inlined),
        source: 'html',
      };
    }

    const text = (input.bodyText ?? '').toString();
    if (text.trim()) {
      return {
        html: `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0">${this.escapeHtml(
          text,
        )}</pre>`,
        hasRemoteImages: false,
        source: 'text',
      };
    }

    return { html: '', hasRemoteImages: false, source: 'empty' };
  }

  /** Map every content-id (with and without <>) to a data: URI. */
  private buildCidMap(attachments: Array<any>): Map<string, string> {
    const map = new Map<string, string>();
    for (const att of attachments) {
      const cid = (att?.cid || att?.contentId || '').toString().trim();
      const content = att?.content;
      if (!cid || !Buffer.isBuffer(content)) continue;
      const mime = (att?.contentType || 'application/octet-stream').toString();
      const dataUri = `data:${mime};base64,${content.toString('base64')}`;
      const bare = cid.replace(/^<|>$/g, '');
      map.set(bare.toLowerCase(), dataUri);
      map.set(`<${bare}>`.toLowerCase(), dataUri);
    }
    return map;
  }

  /** Replace cid: references in the HTML with their inlined data: URI. */
  private inlineCidImages(html: string, cidMap: Map<string, string>): string {
    if (cidMap.size === 0) return html;
    return html.replace(CID_URL_RE, (whole, prefix: string, cid: string) => {
      const key = cid.toLowerCase();
      const dataUri = cidMap.get(key) ?? cidMap.get(`<${key}>`);
      return dataUri ? `${prefix}${dataUri}` : whole;
    });
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
