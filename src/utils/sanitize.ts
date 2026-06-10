const decodeHtmlEntities = (input: string) => {
  // Minimal, dependency-free decoding for common entities + numeric entities.
  // Keep it conservative to avoid unexpected transformations.
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, num) => {
      const codePoint = Number.parseInt(num, 10);
      if (!Number.isFinite(codePoint)) return _;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (!Number.isFinite(codePoint)) return _;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return _;
      }
    });
};

export function sanitizeExtractedValue(value: string): string {
  const raw = (value ?? '').toString();
  if (!raw.trim()) return '';

  // 1) Decode entities first so encoded tags become removable.
  let out = decodeHtmlEntities(raw);

  // Normalize common mailto wrappers produced by email clients / markdown renderers.
  out = out
    .replace(/\[([^\]]+)\]\(mailto:[^)]+\)/gi, '$1')
    .replace(/\b([^\s<>]+@[^\s<>]+)<mailto:[^>]+>/gi, '$1')
    .replace(/<mailto:([^>]+)>/gi, '$1');

  // 2) Normalize common HTML line breaks to whitespace separators.
  out = out
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(div|p|li|tr|td|th)\s*>/gi, '\n')
    .replace(/<\s*(div|p|li|tr|td|th)(\s+[^>]*)?>/gi, '');

  // 3) Strip any remaining tags.
  out = out.replace(/<[^>]*>/g, '');

  // 4) Collapse whitespace/newlines and trim.
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  out = out.replace(/\n+/g, '\n').replace(/[ \t\f\v]+/g, ' ');
  out = out.replace(/\s*\n\s*/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}

// Convert an HTML email body to readable plain text while PRESERVING line
// breaks / paragraph structure. Unlike sanitizeExtractedValue (which collapses
// everything onto a single line for field values), this is meant for storing
// and displaying the full message body.
export function htmlToPlainText(html: string): string {
  const raw = (html ?? '').toString();
  if (!raw.trim()) return '';

  let out = raw;

  // 1) Drop non-content blocks entirely (comments, style/script/head).
  out = out
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(style|script|head)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');

  // 2) Convert <br> and block-level boundaries to newlines.
  out = out
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(
      /<\s*\/\s*(p|div|li|ul|ol|tr|table|h[1-6]|blockquote)\s*>/gi,
      '\n',
    )
    .replace(
      /<\s*(p|div|li|ul|ol|tr|table|h[1-6]|blockquote)(\s+[^>]*)?>/gi,
      '',
    );

  // 3) Strip any remaining tags.
  out = out.replace(/<[^>]*>/g, '');

  // 4) Decode entities (turns &nbsp; into spaces, etc.).
  out = decodeHtmlEntities(out);

  // 5) Normalize whitespace while keeping paragraph breaks.
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  out = out.replace(/[ \t\f\v]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.trim();

  return out;
}

// Some AI gateways return strings with escaped newlines (e.g. "Hello\\nWorld")
// instead of real newline characters. For email drafts we want real newlines.
export function normalizeEscapedNewlines(value: string): string {
  const raw = (value ?? '').toString();
  if (!raw) return '';

  // Handle common double-escaped sequences first.
  let out = raw
    .replace(/\\\\r\\\\n/g, '\n')
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\n');

  // Then single-escaped sequences.
  out = out
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');

  // Normalize newlines
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return out;
}
