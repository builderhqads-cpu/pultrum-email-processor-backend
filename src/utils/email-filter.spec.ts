import { classifyEmailForProcessing } from './email-filter';

describe('classifyEmailForProcessing (deterministic pre-filter)', () => {
  describe('lets real transport emails through', () => {
    it('a normal client order passes', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'planning@derix.de',
        subject: 'Dispoliste Pultrum KW36',
        rawHeaders: 'From: planning@derix.de\r\nSubject: Dispoliste Pultrum KW36',
      });
      expect(d.process).toBe(true);
      expect(d.reason).toBe('ok');
    });

    it('a human reply (RE:) is NOT filtered', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'cor.salentijn@dpworld.com',
        subject: 'RE: Transport Holten > Almelo',
        rawHeaders: 'From: cor.salentijn@dpworld.com\r\nSubject: RE: Transport Holten > Almelo',
      });
      expect(d.process).toBe(true);
    });

    it('a forward (FW:) is NOT filtered', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'nsterken@pultrum-rijssen.nl',
        subject: 'FW: 28-08-2026',
      });
      expect(d.process).toBe(true);
    });

    it('a noreply-style client sender is NOT blocked by default', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'no-reply@ferrymasters.com',
        subject: 'Transport Order - J12834959',
      });
      expect(d.process).toBe(true);
    });

    it('empty input is safe (process)', () => {
      expect(classifyEmailForProcessing({}).process).toBe(true);
    });
  });

  describe('skips bounces / delivery failures', () => {
    it('null return-path (bounce)', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'mailer-daemon@outlook.com',
        subject: 'Undeliverable: your message',
        rawHeaders: 'Return-Path: <>\r\nFrom: mailer-daemon@outlook.com',
      });
      expect(d.process).toBe(false);
      expect(d.reason).toBe('bounce:null-return-path');
    });

    it('multipart/report delivery-status', () => {
      const d = classifyEmailForProcessing({
        subject: 'Delivery Status Notification',
        rawHeaders:
          'Content-Type: multipart/report; report-type=delivery-status;\r\n\tboundary="x"',
      });
      expect(d.process).toBe(false);
      expect(d.reason).toBe('bounce:delivery-status');
    });

    it('mailer-daemon sender', () => {
      const d = classifyEmailForProcessing({ fromEmail: 'MAILER-DAEMON@host.net' });
      expect(d.process).toBe(false);
      expect(d.reason).toContain('system-sender');
    });
  });

  describe('skips auto-replies / out-of-office', () => {
    it('Auto-Submitted header', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'x@a-trans.de',
        subject: 'Re: order',
        rawHeaders: 'Auto-Submitted: auto-replied\r\nFrom: x@a-trans.de',
      });
      expect(d.process).toBe(false);
      expect(d.reason).toBe('auto-submitted');
    });

    it('X-Auto-Response-Suppress header', () => {
      const d = classifyEmailForProcessing({
        rawHeaders: 'X-Auto-Response-Suppress: All',
      });
      expect(d.process).toBe(false);
      expect(d.reason).toBe('x-auto-response-suppress');
    });

    it('German out-of-office subject', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'mark.zehnpfund@a-trans.de',
        subject: 'Automatische Antwort: Transportauftrag',
      });
      expect(d.process).toBe(false);
      expect(d.reason).toBe('subject-auto-reply');
    });

    it('English out of office subject', () => {
      expect(
        classifyEmailForProcessing({ subject: 'Out of Office / Afwezig' }).process,
      ).toBe(false);
    });
  });

  describe('config-driven block list', () => {
    it('blocks a configured sender substring', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'website@pultrum-rijsse.nl',
        subject: 'Nieuwe bericht van: Flynn Birdwood',
        blockSenders: ['website@pultrum-rijsse.nl'],
      });
      expect(d.process).toBe(false);
      expect(d.reason).toContain('blocked-sender');
    });

    it('an empty/whitespace block list is ignored', () => {
      const d = classifyEmailForProcessing({
        fromEmail: 'planning@derix.de',
        subject: 'order',
        blockSenders: ['', '   '],
      });
      expect(d.process).toBe(true);
    });
  });
});
