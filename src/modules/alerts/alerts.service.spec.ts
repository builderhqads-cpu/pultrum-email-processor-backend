import { AlertsService } from './alerts.service';

function makeService(
  config: Record<string, string>,
  sendImpl?: jest.Mock,
) {
  const sendEmail = sendImpl ?? jest.fn().mockResolvedValue({ ok: true });
  const configService = {
    get: (key: string) => config[key],
  } as any;
  const emailSender = { sendEmail } as any;
  return { service: new AlertsService(configService, emailSender), sendEmail };
}

describe('AlertsService', () => {
  it('does nothing when no recipients are configured', async () => {
    const { service, sendEmail } = makeService({});
    await service.notifyIncident({ type: 'ai', title: 'x' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends one e-mail per recipient when configured', async () => {
    const { service, sendEmail } = makeService({
      ALERT_EMAILS: 'a@x.com, b@x.com',
      ALERT_FROM_MAILBOX: 'planning@x.com',
    });
    await service.notifyIncident({
      type: 'xml',
      title: 'Rejeitado',
      reference: 'J1',
      error: 'HTTP 500',
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const call = sendEmail.mock.calls[0][0];
    expect(call.mailboxEmail).toBe('planning@x.com');
    expect(call.subject).toContain('Envio de XML');
    expect(call.subject).toContain('Rejeitado');
    expect(call.body).toContain('J1');
    expect(call.body).toContain('HTTP 500');
  });

  it('throttles repeated alerts of the SAME type but not a different type', async () => {
    const { service, sendEmail } = makeService({
      ALERT_EMAILS: 'a@x.com',
      ALERT_COOLDOWN_MINUTES: '30',
    });
    await service.notifyIncident({ type: 'ai', title: 'first' });
    await service.notifyIncident({ type: 'ai', title: 'second (suppressed)' });
    await service.notifyIncident({ type: 'xml', title: 'other type' });
    // ai sent once (second suppressed), xml sent once.
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('is disabled when ALERTS_ENABLED=false even with recipients', async () => {
    const { service, sendEmail } = makeService({
      ALERT_EMAILS: 'a@x.com',
      ALERTS_ENABLED: 'false',
    });
    await service.notifyIncident({ type: 'email', title: 'x' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when sending fails', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('graph down'));
    const { service } = makeService({ ALERT_EMAILS: 'a@x.com' }, failing);
    await expect(
      service.notifyIncident({ type: 'ai', title: 'x' }),
    ).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalled();
  });
});
