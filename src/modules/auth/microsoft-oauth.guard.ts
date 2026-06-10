import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { GraphAuthService } from '../graph/graph-auth.service';

@Injectable()
export class MicrosoftOAuthGuard extends AuthGuard('microsoft') {
  constructor(
    private readonly configService: ConfigService,
    private readonly graphAuthService: GraphAuthService,
  ) {
    super();
  }

  override async canActivate(context: any) {
    const clientId = (
      this.configService.get<string>('MS_CLIENT_ID') || ''
    ).trim();
    const clientSecret = (
      this.configService.get<string>('MS_CLIENT_SECRET') || ''
    ).trim();
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        'Microsoft OAuth is not configured. Set MS_CLIENT_ID and MS_CLIENT_SECRET.',
      );
    }
    return super.canActivate(context) as any;
  }

  override getAuthenticateOptions(context: any) {
    const request = context.switchToHttp().getRequest() as {
      params?: { mailboxId?: string };
    };
    const mailboxId = request.params?.mailboxId?.trim();
    if (!mailboxId) return {};

    return {
      state: this.graphAuthService.createMailboxState(mailboxId),
    };
  }
}
