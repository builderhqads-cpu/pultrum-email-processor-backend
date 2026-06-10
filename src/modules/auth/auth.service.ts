import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';

export type AuthUserResponse = {
  id: string;
  name: string;
  email: string;
  role: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private getExpiresIn() {
    return (this.configService.get<string>('JWT_EXPIRES_IN') || '12h').trim();
  }

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: this.getExpiresIn() as any,
    });

    const safe = this.usersService.toSafeUser(user);
    return {
      accessToken,
      user: {
        id: safe.id,
        name: safe.name,
        email: safe.email,
        role: safe.role,
      } satisfies AuthUserResponse,
    };
  }
}
