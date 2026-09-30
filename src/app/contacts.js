// Address suggestions for the To/Cc/Bcc fields, built from mail you have
// seen and sent. Kept in chrome.storage.local on this computer only.

const KEY = 'contacts';
const LIMIT = 2000;

let book = null; // email -> { name, score, last }
let saveTimer;

async function ensure() {
  if (!book) {
    const { [KEY]: stored = {} } = await chrome.storage.local.get(KEY);
    book = new Map(Object.entries(stored));
  }
  return book;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Keep the most useful entries.
    const entries = [...book].sort(([, a], [, b]) => rank(b) - rank(a)).slice(0, LIMIT);
    book = new Map(entries);
    chrome.storage.local.set({ [KEY]: Object.fromEntries(entries) }).catch(() => {});
  }, 2000);
}

// Frequently and recently used addresses first.
const rank = (c) => c.score + (c.last ?? 0) / 86400e3 / 30;

const ignored = (email) => !email || !email.includes('@') || /(^|[.+_-])(no-?reply|do-?not-?reply|mailer-daemon|bounce[s]?)([.+_-]|@)/i.test(email);

// weight: 1 for addresses seen in mail, more for people you wrote to.
export async function rememberAddresses(list, weight = 1) {
  const b = await ensure();
  const now = Date.now();
  let changed = false;
  for (const a of list ?? []) {
    const email = a?.email?.trim().toLowerCase();
    if (ignored(email)) continue;
    const prev = b.get(email);
    const name = a.name && a.name !== a.email ? a.name : prev?.name ?? '';
    b.set(email, { name, score: (prev?.score ?? 0) + weight, last: Math.max(prev?.last ?? 0, now) });
    changed = true;
  }
  if (changed) save();
}

// Up to `limit` matches for what was typed: by the start of the address, of
// the name, or of any word in the name.
export async function suggest(query, { limit = 6, exclude = new Set() } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const b = await ensure();
  const out = [];
  for (const [email, c] of b) {
    if (exclude.has(email)) continue;
    const name = (c.name ?? '').toLowerCase();
    const starts = email.startsWith(q) || name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q));
    if (starts || email.includes(q)) out.push({ email, name: c.name, score: rank(c) + (starts ? 1000 : 0) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
