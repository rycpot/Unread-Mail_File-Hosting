// Update check: compares this extension's version with manifest.json on the
// GitHub branch it is installed from. Installing is done by the IMAP helper
// (cmd "selfUpdate"), because an unpacked extension cannot change its own files.

export const REPO = 'rycpot/Unread-Mail_File-Hosting';
export const BRANCH = 'claude/blissful-faraday-8ykg9h';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

export const currentVersion = () => chrome.runtime.getManifest().version;

// 1 if a > b, -1 if a < b, 0 if equal ("0.10.0" > "0.9.1").
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function getJson(path) {
  const res = await fetch(`${RAW}/${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return res.json();
}

// Stores { version, notes: [{ version, text }], checkedAt } under "update".
// notes lists what changed in each version newer than the installed one.
export async function checkForUpdate() {
  const { version } = await getJson('manifest.json');
  const changes = await getJson('changes.json').catch(() => ({}));
  const notes = Object.entries(changes)
    .filter(([v]) => compareVersions(v, currentVersion()) > 0 && compareVersions(v, version) <= 0)
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([v, text]) => ({ version: v, text: String(text) }));
  const update = { version, notes, checkedAt: Date.now() };
  await chrome.storage.local.set({ update });
  return update;
}
