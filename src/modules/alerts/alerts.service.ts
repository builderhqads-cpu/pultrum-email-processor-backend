import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSenderService } from '../email-sender/email-sender.service';

export type IncidentType = 'ai' | 'xml' | 'email';

export type IncidentAlert = {
  type: IncidentType;
  /** Short cause, e.g. "402 sem créditos" or "Rejeitado pelo Transpas". */
  title: string;
  /** Order/shipment reference, when known. */
  reference?: string | null;
  /** Raw error detail, when known. */
  error?: string | null;
  /** Extra context lines (label -> value). */
  context?: Record<string, string | null | undefined>;
};

/**
 * Sends incident alert e-mails to the operators (ALERT_EMAILS) when the pipeline
 * fails — AI processing, XML delivery or e-mail processing. Real-time with a
 * per-type cooldown so a burst of the same failure (e.g. a router 402 storm)
 * doesn't flood the inbox. Best-effort: sending an alert must NEVER break the
 * pipeline, so every path is wrapped and failures are only logged.
 *
 * No secrets involved — this only sends mail through the existing Graph sender.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly lastSentByType = new Map<IncidentType, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly emailSenderService: EmailSenderService,
  ) {}

  private recipients(): string[] {
    return (this.configService.get<string>('ALERT_EMAILS') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private enabled(): boolean {
    const flag = (this.configService.get<string>('ALERTS_ENABLED') || '')
      .trim()
      .toLowerCase();
    if (flag === 'false') return false;
    // Enabled as soon as recipients are configured (unless explicitly disabled).
    return this.recipients().length > 0;
  }

  private cooldownMs(): number {
    const min =
      Number(this.configService.get<string>('ALERT_COOLDOWN_MINUTES') || '30') ||
      30;
    return Math.max(0, min) * 60 * 1000;
  }

  private fromMailbox(): string | null {
    return (
      (
        this.configService.get<string>('ALERT_FROM_MAILBOX') ||
        this.configService.get<string>('OPEN_TRANSPORT_MAILBOX') ||
        ''
      ).trim() || null
    );
  }

  private typeLabel(type: IncidentType): string {
    switch (type) {
      case 'ai':
        return 'IA';
      case 'xml':
        return 'Envio de XML';
      case 'email':
        return 'E-mail';
    }
  }

  private buildBody(alert: IncidentAlert): string {
    const when = new Date().toISOString();
    const lines: string[] = [
      'Um incidente foi detectado no sistema Pultrum.',
      '',
      `Tipo: ${this.typeLabel(alert.type)}`,
      `Causa: ${alert.title}`,
      `Referência: ${alert.reference || '—'}`,
      `Quando: ${when}`,
    ];
    for (const [label, value] of Object.entries(alert.context ?? {})) {
      const v = (value ?? '').toString().trim();
      if (v) lines.push(`${label}: ${v}`);
    }
    lines.push('', 'Erro:', (alert.error || '—').toString().slice(0, 1500));
    lines.push(
      '',
      `(Alerta automático. Novos alertas do tipo "${this.typeLabel(alert.type)}" são suprimidos por ${Math.round(this.cooldownMs() / 60000)} min.)`,
    );
    return lines.join('\n');
  }

  /** Fire an incident alert (throttled, best-effort). Never throws. */
  async notifyIncident(alert: IncidentAlert): Promise<void> {
    try {
      if (!this.enabled()) return;

      const now = Date.now();
      const last = this.lastSentByType.get(alert.type) ?? 0;
      if (now - last < this.cooldownMs()) {
        this.logger.log(
          `Incident alert suppressed (cooldown) type=${alert.type} title=${alert.title}`,
        );
        return;
      }
      this.lastSentByType.set(alert.type, now);

      const recipients = this.recipients();
      const from = this.fromMailbox();
      const subject = `[Pultrum] Incidente ${this.typeLabel(alert.type)} — ${alert.title}`;
      const body = this.buildBody(alert);

      for (const to of recipients) {
        await this.emailSenderService.sendEmail({
          mailboxEmail: from,
          toEmail: to,
          subject,
          body,
        });
      }

      this.logger.warn(
        `Incident alert sent type=${alert.type} title="${alert.title}" to=${recipients.join(', ')}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to send incident alert (type=${alert.type}): ${err?.message ?? err}`,
      );
    }
  }
}
