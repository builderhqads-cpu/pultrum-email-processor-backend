import { Injectable } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type SafeUser = Pick<User, 'id' | 'name' | 'email' | 'role' | 'active'>;

@Injectable()
export class UsersService {
  constructor(private readonly prismaService: PrismaService) {}

  toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    };
  }

  async findByEmail(email: string): Promise<User | null> {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    return this.prismaService.user.findUnique({ where: { email: normalized } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prismaService.user.findUnique({ where: { id } });
  }

  async create(params: {
    name: string;
    email: string;
    passwordHash: string;
    role?: UserRole;
    active?: boolean;
  }): Promise<User> {
    return this.prismaService.user.create({
      data: {
        name: params.name,
        email: params.email.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        role: params.role ?? UserRole.OPERATOR,
        active: params.active ?? true,
      },
    });
  }
}

