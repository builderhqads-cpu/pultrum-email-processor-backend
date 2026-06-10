import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: (configService.get<string>('JWT_SECRET') || 'dev-secret')
        .trim(),
    });
  }

  async validate(payload: any) {
    const userId = payload?.sub as string | undefined;
    if (!userId) throw new UnauthorizedException();

    const user = await this.usersService.findById(userId);
    if (!user || !user.active) throw new UnauthorizedException();

    return this.usersService.toSafeUser(user);
  }
}

