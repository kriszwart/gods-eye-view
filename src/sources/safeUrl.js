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

const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'commons.wikimedia.org']);

/**
 * Return an image URL unchanged when it parses as an absolute https URL
 * whose hostname is exactly upload.wikimedia.org or commons.wikimedia.org,
 * else null. Guards dossier images against http, unsafe schemes and
 * lookalike hosts (eg. commons.wikimedia.org.evil.com). Portable: only the
 * URL constructor, no browser globals.
 */
export function safeImageUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname)
      ? value
      : null;
  } catch {
    return null;
  }
}
