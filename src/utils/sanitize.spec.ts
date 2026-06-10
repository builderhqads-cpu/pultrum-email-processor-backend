import { sanitizeExtractedValue } from './sanitize';
import { htmlToPlainText } from './sanitize';
import { normalizeEscapedNewlines } from './sanitize';

describe('sanitizeExtractedValue', () => {
  it('removes <br> tags', () => {
    expect(sanitizeExtractedValue('1234567890<br>')).toBe('1234567890');
  });

  it('removes closing div tags', () => {
    expect(sanitizeExtractedValue('250</div>')).toBe('250');
  });

  it('keeps special characters', () => {
    expect(sanitizeExtractedValue('Rodgaustraße 7<br>')).toBe('Rodgaustraße 7');
  });

  it('keeps email characters', () => {
    expect(sanitizeExtractedValue('pickup@example.com<br>')).toBe(
      'pickup@example.com',
    );
  });

  it('normalizes markdown mailto links to plain email text', () => {
    expect(
      sanitizeExtractedValue('[pickup@example.com](mailto:pickup@example.com)'),
    ).toBe('pickup@example.com');
  });

  it('normalizes mailto angle-bracket links to plain email text', () => {
    expect(
      sanitizeExtractedValue('pickup@example.com<mailto:pickup@example.com>'),
    ).toBe('pickup@example.com');
  });

  it('decodes entities and strips tags', () => {
    expect(sanitizeExtractedValue('123&lt;br&gt;')).toBe('123');
    expect(sanitizeExtractedValue('250&lt;/div&gt;')).toBe('250');
  });
});

describe('htmlToPlainText', () => {
  it('preserves paragraph breaks from <p> blocks', () => {
    expect(htmlToPlainText('<p>Line one</p><p>Line two</p>')).toBe(
      'Line one\nLine two',
    );
  });

  it('converts <br> to newlines', () => {
    expect(htmlToPlainText('A<br>B<br/>C')).toBe('A\nB\nC');
  });

  it('decodes &nbsp; to spaces', () => {
    expect(htmlToPlainText('John&nbsp;Hansen')).toBe('John Hansen');
  });

  it('drops style/script blocks', () => {
    expect(
      htmlToPlainText('<style>p{color:red}</style><p>Hello</p>'),
    ).toBe('Hello');
  });

  it('keeps the full body without truncating long content', () => {
    const longLine = 'word '.repeat(200).trim();
    const html = `<div>${longLine}</div>`;
    const result = htmlToPlainText(html);
    expect(result).toBe(longLine);
    expect(result.length).toBeGreaterThan(255);
  });

  it('extracts the full multi-paragraph transport request body', () => {
    const html = [
      '<html><head><style>body{font-family:sans}</style></head><body>',
      '<p>Goedemorgen,</p>',
      '<p>Graag wil ik een transportopdracht aanvragen voor een zending ',
      'die op 1 juni 2026 om 10:00 uur opgehaald moet worden.</p>',
      '<p>De levering dient plaats te vinden op 2 juni 2026 om 12:00 uur.</p>',
      '<p>Met vriendelijke groet,</p>',
      '</body></html>',
    ].join('');

    const result = htmlToPlainText(html);

    expect(result).toContain('Goedemorgen,');
    expect(result).toContain('1 juni 2026 om 10:00 uur');
    expect(result).toContain('2 juni 2026 om 12:00 uur');
    expect(result).toContain('Met vriendelijke groet,');
    expect(result).not.toContain('font-family');
    expect(result).not.toMatch(/<[^>]+>/);
  });
});

describe('normalizeEscapedNewlines', () => {
  it('converts escaped \\n to newlines', () => {
    expect(normalizeEscapedNewlines('Hello\\nWorld')).toBe('Hello\nWorld');
  });

  it('converts escaped \\r\\n to newlines', () => {
    expect(normalizeEscapedNewlines('A\\r\\nB')).toBe('A\nB');
  });

  it('handles double-escaped sequences', () => {
    expect(normalizeEscapedNewlines('A\\\\nB')).toBe('A\nB');
  });
});
