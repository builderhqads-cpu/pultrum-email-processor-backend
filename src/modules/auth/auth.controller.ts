import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { MicrosoftOAuthGuard } from './microsoft-oauth.guard';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { GraphAuthService } from '../graph/graph-auth.service';

type RequestWithUser = {
  params?: {
    mailboxId?: string;
  };
  query?: {
    state?: string;
  };
  user?: {
    accessToken?: string;
    refreshToken?: string;
    expiresInSeconds?: number;
    expiresAt?: number;
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly graphAuthService: GraphAuthService,
  ) {}

  @Get('microsoft')
  @UseGuards(MicrosoftOAuthGuard)
  microsoftLogin() {
    return {
      ok: false,
      message:
        'Use /auth/microsoft/mailboxes/:mailboxId to connect a specific mailbox.',
    };
  }

  @Get('microsoft/mailboxes/:mailboxId')
  @UseGuards(MicrosoftOAuthGuard)
  // passport-oauth2 handles the redirect
  microsoftMailboxLogin() {}

  @Get('callback')
  @UseGuards(MicrosoftOAuthGuard)
  async microsoftCallback(@Req() req: RequestWithUser, @Res() res: Response) {
    try {
      const state = this.graphAuthService.parseMailboxState(req.query?.state);
      if (!req.user?.accessToken) {
        throw new Error('Microsoft OAuth access token is missing.');
      }

      await this.graphAuthService.persistMailboxConnection(state.mailboxId, {
        accessToken: req.user.accessToken,
        refreshToken: req.user.refreshToken,
        expiresInSeconds: req.user.expiresInSeconds,
      });

      return res.redirect(
        this.graphAuthService.buildFrontendSettingsRedirectUrl({
          status: 'connected',
          mailboxId: state.mailboxId,
        }),
      );
    } catch (error) {
      let mailboxId: string | undefined;
      try {
        mailboxId = this.graphAuthService.parseMailboxState(
          req.query?.state,
        ).mailboxId;
      } catch {
        mailboxId = undefined;
      }

      const redirectUrl =
        this.graphAuthService.buildFrontendSettingsRedirectUrl({
          status: 'error',
          mailboxId,
          reason:
            error instanceof Error ? error.message : 'oauth_callback_failed',
        });
      return res.redirect(redirectUrl);
    }
  }

  @Get('microsoft/status')
  @UseGuards(JwtAuthGuard)
  microsoftStatus() {
    return this.graphAuthService.getAllMailboxConnectionStatuses();
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body?.email, body?.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: RequestWithUser) {
    return req.user;
  }
}
