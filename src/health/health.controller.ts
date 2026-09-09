import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  getHealth() {
    const mailProvider =
      (this.configService.get<string>('MAIL_PROVIDER') || 'graph').trim() ||
      'graph';

    const imapHost = (this.configService.get<string>('IMAP_HOST') || '').trim();
    const imapUser = (this.configService.get<string>('IMAP_USER') || '').trim();

    const creativeGearsApiUrl = (
      this.configService.get<string>('CREATIVE_GEARS_API_URL') || ''
    ).trim();

    let creativeGearsEndpoint: string | null = null;
    if (creativeGearsApiUrl) {
      try {
        creativeGearsEndpoint = new URL(creativeGearsApiUrl).host;
      } catch {
        creativeGearsEndpoint = creativeGearsApiUrl;
      }
    }

    const aiApiUrl = (
      this.configService.get<string>('AI_API_URL') ||
      this.configService.get<string>('AI_API_BASE_URL') ||
      ''
    ).trim();

    // Identifier of the AI router endpoint (host only — no key/path). Lets the UI
    // show WHICH router is wired (e.g. the "-teste" one vs production) without
    // exposing anything secret. The URL itself is not a credential.
    let aiEndpoint: string | null = null;
    if (aiApiUrl) {
      try {
        aiEndpoint = new URL(aiApiUrl).host;
      } catch {
        aiEndpoint = aiApiUrl;
      }
    }

    return {
      status: 'ok',
      config: {
        mailProvider: mailProvider.toLowerCase() === 'imap' ? 'imap' : 'graph',
        imap: {
          host: imapHost || null,
          user: imapUser || null,
          configured: Boolean(imapHost && imapUser),
        },
        creativeGears: {
          endpointConfigured: Boolean(creativeGearsApiUrl),
          endpoint: creativeGearsEndpoint,
        },
        ai: {
          apiConfigured: Boolean(aiApiUrl),
          endpoint: aiEndpoint,
        },
      },
    };
  }
}
