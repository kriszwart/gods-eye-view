/**
 * Return a source URL unchanged when it parses as an absolute http or https
 * URL, else null. Guards dossier links against javascript:, data: and other
 * unsafe schemes, and against protocol-relative or unparsable values.
 * Portable: only the URL constructor, no browser globals.
 */
export function safeSourceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
