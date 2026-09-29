// Reads a decrypted Proton email from a Proton Mail tab: one background tab is
// opened (not focused) on the email, the content script copies what Proton
// renders, and the tab is reused for the next email and closed when idle.

const IDLE_CLOSE_MS = 3 * 60 * 1000;
const READY_TIMEOUT_MS = 30000;

let tabId = null;
let closeTimer = null;
let lastMarker = '';
let lastId = null;

async function liveTab() {
  if (tabId == null) return null;
  try {
    await chrome.tabs.get(tabId);
    return tabId;
  } catch {
    tabId = null;
    return null;
  }
}

// Resolves once the content script in the tab answers.
async function waitForScript(id) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.tabs.sendMessage(id, { cmd: 'protonPing' });
      if (res?.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Proton Mail did not load. Check that you are signed in at mail.proton.me.');
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    const id = await liveTab();
    if (id != null) chrome.tabs.remove(id).catch(() => {});
    tabId = null;
  }, IDLE_CLOSE_MS);
}
addEventListener('pagehide', () => {
  if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
});

export async function readInProtonTab(messageId, localId = 0) {
  const url = `https://mail.proton.me/u/${localId}/inbox/${encodeURIComponent(messageId)}`;
  let id = await liveTab();
  if (id == null) {
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = await chrome.tabs.create({ url, active: false, ...(current && { index: current.index + 1 }) });
    tabId = id = tab.id;
    lastMarker = '';
    lastId = null;
  }
  clearTimeout(closeTimer);
  try {
    await waitForScript(id);
    // "before" lets the script skip the previous email's body while Proton is
    // still switching; it does not apply when the same email is read again.
    const before = lastId === messageId ? '' : lastMarker;
    const res = await chrome.tabs.sendMessage(id, { cmd: 'protonRead', id: messageId, before });
    if (!res?.ok) throw new Error(res?.error ?? 'Could not read the email from Proton');
    lastMarker = res.marker;
    lastId = messageId;
    return res;
  } finally {
    scheduleClose();
  }
}
