import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Renovo-only gate for the cost/audit reports (Renato 2026-10-05). The report
 * exposes the REAL per-e-mail cost (Renovo's margin), so it is restricted to an
 * allowlist of e-mails — NOT the regular ADMIN role. Configure with
 * AUDIT_ADMIN_EMAILS (comma-separated); defaults to the local admin + the
 * production Renovo account so it works out of the box in both environments.
 *
 * Use AFTER JwtAuthGuard so req.user is populated.
 */
@Injectable()
export class RenovoAdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const email = (request.user?.email || '').trim().toLowerCase();

    const allowed = (
      this.configService.get<string>('AUDIT_ADMIN_EMAILS') ||
      'admin@renovoia.local,admin@renovoia.com,contact@evoluicomia.com.br'
    )
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (!email || !allowed.includes(email)) {
      throw new ForbiddenException('Audit reports are restricted.');
    }
    return true;
  }
}
