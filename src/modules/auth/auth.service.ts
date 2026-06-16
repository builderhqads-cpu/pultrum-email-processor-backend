import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from '@prisma/client';
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

  private async buildSession(user: User) {
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

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    return this.buildSession(user);
  }

  async register(input: {
    name: string;
    email: string;
    password: string;
    code: string;
  }) {
    // Registration is gated by a shared code in REGISTRATION_CODE. If unset,
    // registration is disabled so it can never be left open by accident.
    const expected = (
      this.configService.get<string>('REGISTRATION_CODE') || ''
    ).trim();
    if (!expected) {
      throw new ForbiddenException('Registration is disabled');
    }
    if ((input.code || '').trim() !== expected) {
      throw new ForbiddenException('Invalid registration code');
    }

    const name = (input.name || '').trim();
    const email = (input.email || '').trim().toLowerCase();
    const password = input.password || '';
    if (!name || !email || password.length < 6) {
      throw new BadRequestException(
        'Name, email and a password (min. 6 characters) are required',
      );
    }

    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.usersService.create({
      name,
      email,
      passwordHash,
      role: UserRole.OPERATOR,
      active: true,
    });
    return this.buildSession(user);
  }

  async resetPassword(input: { email: string; password: string; code: string }) {
    // Same shared code as registration. Empty REGISTRATION_CODE disables it.
    const expected = (
      this.configService.get<string>('REGISTRATION_CODE') || ''
    ).trim();
    if (!expected) {
      throw new ForbiddenException('Password reset is disabled');
    }
    if ((input.code || '').trim() !== expected) {
      throw new ForbiddenException('Invalid code');
    }

    const email = (input.email || '').trim().toLowerCase();
    const password = input.password || '';
    if (!email || password.length < 6) {
      throw new BadRequestException(
        'Email and a new password (min. 6 characters) are required',
      );
    }

    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new NotFoundException('No account found for this email');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.usersService.updatePassword(user.id, passwordHash);
    return { ok: true };
  }
}
