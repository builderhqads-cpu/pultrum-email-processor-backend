import { EmailOriginalService } from './email-original.service';

describe('EmailOriginalService', () => {
  const service = new EmailOriginalService();

  it('inlines cid: images from the parsed .eml as data URIs', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const eml = [
      'Content-Type: multipart/related; boundary="b"',
      'MIME-Version: 1.0',
      '',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hi</p><img src="cid:logo123">',
      '--b',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo123>',
      'Content-Disposition: inline; filename="logo.png"',
      '',
      png,
      '--b--',
      '',
    ].join('\r\n');

    const result = await service.render({
      rawMimeBase64: Buffer.from(eml).toString('base64'),
    });

    expect(result.source).toBe('html');
    expect(result.html).toContain('src="data:image/png;base64,');
    expect(result.html).not.toContain('cid:logo123');
    expect(result.hasRemoteImages).toBe(false);
  });

  it('reports remote images so the UI can block them', async () => {
    const result = await service.render({
      bodyHtml: '<p>Hello</p><img src="https://tracker.example/pixel.gif">',
    });

    expect(result.hasRemoteImages).toBe(true);
    expect(result.html).toContain('https://tracker.example/pixel.gif');
  });

  it('falls back to escaped plain text when there is no HTML', async () => {
    const result = await service.render({
      bodyText: 'plain <b>not bold</b> body',
    });

    expect(result.source).toBe('text');
    expect(result.html).toContain('&lt;b&gt;');
    expect(result.hasRemoteImages).toBe(false);
  });

  it('returns empty when there is nothing to show', async () => {
    const result = await service.render({});
    expect(result.source).toBe('empty');
    expect(result.html).toBe('');
  });
});
