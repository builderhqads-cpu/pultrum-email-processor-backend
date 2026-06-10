import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { GraphModule } from './modules/graph/graph.module';
import { MailboxesModule } from './modules/mailboxes/mailboxes.module';
import { EmailsModule } from './modules/emails/emails.module';
import { QueuesModule } from './modules/queues/queues.module';
import { ProcessorsModule } from './modules/processors/processors.module';
import { OrdersModule } from './modules/orders/orders.module';
import { RequiredFieldsModule } from './modules/required-fields/required-fields.module';
import { AiClientModule } from './modules/ai-client/ai-client.module';
import { AiClassificationModule } from './modules/ai-classification/ai-classification.module';
import { SystemSettingsModule } from './modules/system-settings/system-settings.module';
import { XmlModule } from './modules/xml/xml.module';
import { CreativeGearsModule } from './modules/creative-gears/creative-gears.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Always load the project's `.env` (next to `package.json`).
      envFilePath: path.resolve(__dirname, '..', '.env'),
    }),
    ScheduleModule.forRoot(),
    HealthModule,
    PrismaModule,
    GraphModule,
    MailboxesModule,
    EmailsModule,
    QueuesModule,
    ProcessorsModule,
    OrdersModule,
    RequiredFieldsModule,
    AiClientModule,
    AiClassificationModule,
    SystemSettingsModule,
    XmlModule,
    CreativeGearsModule,
    AuditLogModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
