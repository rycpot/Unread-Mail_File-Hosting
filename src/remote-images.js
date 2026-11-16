// Saves an email's web ("remote") images with it in the offline cache, so the
// email shows at once instead of fetching them from the web on every open.
// Only done while Settings → "Always load remote images" is on: fetching an
// image tells its sender the email was opened, and here that happens when the
// email is downloaded in the background. No DOM APIs (runs in the service
// worker); src/app/render-email.js points the email at the saved copies.

import { bytesToDataUrl } from './message-fetch.js';

const MAX_IMAGES = 80;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10e3;
const PARALLEL = 6;

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The http(s) image URLs an email's HTML refers to: <img src>, background
// attributes and CSS url(...). Protocol-relative URLs are read as https.
export function remoteImageUrls(html) {
  const urls = new Set();
  const add = (raw) => {
    let url = decodeEntities(raw.trim());
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^https?:\/\//i.test(url)) urls.add(url);
  };
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(/\sbackground\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(/url\(\s*(?:&quot;|&#39;|["'])?\s*((?:https?:)?\/\/[^)"']+?)\s*(?:&quot;|&#39;|["'])?\s*\)/gi)) add(m[1]);
  return [...urls].slice(0, MAX_IMAGES);
}

async function fetchImage(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no type'})`);
  if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('too large');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('too large');
  return { bytes, type };
}

// Fetches the email's web images into msg.remoteImages (Map of URL -> data:
// URL). Images that fail, are too large or would take the email over the size
// limit are left out and load from the web as before. Returns true if the
// message changed (the caller stores it).
export async function saveRemoteImages(msg) {
  if (!msg.html || msg.encrypted || msg.remoteImages) return false;
  const urls = remoteImageUrls(msg.html);
  const saved = new Map();
  let total = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const { bytes, type } = await fetchImage(url);
        if (total + bytes.length > MAX_TOTAL_BYTES) continue;
        total += bytes.length;
        saved.set(url, bytesToDataUrl(bytes, type));
      } catch (e) {
        console.debug('[remote image]', url, e.message);
      }
    }
  }));
  msg.remoteImages = saved;
  return true;
}
