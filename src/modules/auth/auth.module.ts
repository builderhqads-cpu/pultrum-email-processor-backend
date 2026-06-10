import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphModule } from '../graph/graph.module';
import { AuthController } from './auth.controller';
import { MicrosoftStrategy } from './microsoft.strategy';
import { MicrosoftOAuthGuard } from './microsoft-oauth.guard';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ session: false }),
    GraphModule,
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: (configService.get<string>('JWT_SECRET') || 'dev-secret').trim(),
        signOptions: {
          expiresIn: (configService.get<string>('JWT_EXPIRES_IN') || '12h')
            .trim() as any,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    MicrosoftStrategy,
    MicrosoftOAuthGuard,
    AuthService,
    JwtStrategy,
  ],
  exports: [JwtModule],
})
export class AuthModule {}
