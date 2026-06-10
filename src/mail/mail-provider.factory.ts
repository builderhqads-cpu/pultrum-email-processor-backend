import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphAuthService } from '../modules/graph/graph-auth.service';
import { MailProvider } from './providers/mail-provider.interface';
import { GraphMailProvider } from './providers/graph-mail.provider';
import { ImapMailProvider } from './providers/imap-mail.provider';

@Injectable()
export class MailProviderFactory {
  constructor(
    private readonly configService: ConfigService,
    private readonly graphAuthService: GraphAuthService,
  ) {}

  getConfiguredProvider(): 'graph' | 'imap' {
    const provider = (
      this.configService.get<string>('MAIL_PROVIDER') || 'graph'
    )
      .trim()
      .toLowerCase();
    return provider === 'imap' ? 'imap' : 'graph';
  }

  createForMailbox(mailboxEmail: string): MailProvider {
    if (this.getConfiguredProvider() === 'imap') {
      return new ImapMailProvider(this.configService);
    }

    return new GraphMailProvider(this.graphAuthService, mailboxEmail);
  }
}
