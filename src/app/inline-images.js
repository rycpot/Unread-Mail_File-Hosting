// Points an email's <img> elements at its inline image parts.
//
// Most emails reference inline images as cid:<content-id>. Some do not:
//   * Gmail's web app keeps images in drafts as links to its own servers
//     (…?view=fimg…&realattid=ii_…), where realattid is the part's content id;
//   * other apps leave only the file name in alt.
// Such images are matched by realattid, then by file name, then (for image
// links that clearly point at an attachment) in order. Parts still unmatched
// are returned so callers never silently lose an image.

// parts: [{ contentId, filename, url }]. onLink(img, part) is called for
// each image pointed at a part. Returns the parts that were not used.
export function linkInlineImages(root, parts, onLink = () => {}) {
  const used = new Set();
  const byCid = new Map(parts.filter((p) => p.contentId).map((p) => [p.contentId.toLowerCase(), p]));
  const link = (img, part) => {
    used.add(part);
    img.setAttribute('src', part.url);
    onLink(img, part);
  };
  const pending = [];
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (/^data:/i.test(src)) continue;
    let key = null;
    if (/^cid:/i.test(src)) key = safeDecode(src.slice(4));
    else key = safeDecode(src.match(/[?&]realattid=([^&#]+)/i)?.[1] ?? '');
    let part = key ? byCid.get(key.toLowerCase()) : null;
    if (!part) {
      const alt = img.getAttribute('alt');
      if (alt) part = parts.find((p) => !used.has(p) && p.filename === alt);
    }
    if (part) link(img, part);
    else if (/^cid:/i.test(src) || /[?&](view=fimg|attid=|realattid=)/i.test(src)) pending.push(img);
  }
  const rest = parts.filter((p) => !used.has(p));
  for (const img of pending) {
    const part = rest.shift();
    if (!part) break;
    link(img, part);
  }
  return parts.filter((p) => !used.has(p));
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Inline image parts of a message whose bytes are loaded (url is a data: URL).
export function inlineParts(msg) {
  const images = msg.inlineImages ?? new Map();
  return (msg.attachments ?? [])
    .filter((a) => a.contentId && images.has(a.contentId))
    .map((a) => ({ contentId: a.contentId, filename: a.filename, url: images.get(a.contentId) }));
}
