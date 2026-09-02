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

    // Intake folder: when set, the sync reads ONLY this custom folder (e.g. the
    // planner's "AI BOB") instead of the whole Inbox. Empty = Inbox (back-compat).
    const intakeFolder = (
      this.configService.get<string>('GRAPH_INTAKE_FOLDER') || ''
    ).trim();

    return new GraphMailProvider(
      this.graphAuthService,
      mailboxEmail,
      intakeFolder || null,
    );
  }
}
