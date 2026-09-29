// Small helpers shared by the providers. No DOM APIs: these also run in the
// background service worker.

// "Jane Doe" <jane@x.com>, jane@x.com, Jane <jane@x.com>
export function parseAddress(value) {
  const s = (value ?? '').trim();
  const m = s.match(/^\s*"?(.*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/\\"/g, '"').trim(), email: m[2].trim() };
  return { name: '', email: s };
}

// Split a header address list on commas that are not inside quotes or <>.
export function parseAddressList(value) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of value ?? '') {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (ch === ',' && !quoted && !angle) {
      if (cur.trim()) out.push(parseAddress(cur));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(parseAddress(cur));
  return out;
}

export function base64ToBytes(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function decodeText(bytes, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Gmail snippets arrive HTML-escaped.
export function decodeEntities(s) {
  return (s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Promise.all with a concurrency cap, to stay polite with API rate limits.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
