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

const TOTAL_TIMEOUT_MS = 45000;
let lastPath = '';

// Resolves once the content script reports that Proton's mail app is loaded.
async function waitForScript(id, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await chrome.tabs.sendMessage(id, { cmd: 'protonPing' });
      lastPath = res?.path ?? lastPath;
      if (res?.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Proton Mail did not load (tab is at ${lastPath || 'an unknown page'}). Check that you are signed in at mail.proton.me.`);
}

// The page reloading or redirecting while a request is pending closes the
// message channel; that is retried rather than reported.
const PAGE_CHANGED = /message channel closed|Receiving end does not exist|back\/forward cache|message port closed/i;

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

export async function readInProtonTab(messageId, conversationId, localId = 0) {
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
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  try {
    for (;;) {
      await waitForScript(id, deadline);
      // "before" lets the script skip the previous email's body while Proton is
      // still switching; it does not apply when the same email is read again.
      const before = lastId === messageId ? '' : lastMarker;
      let res;
      try {
        res = await chrome.tabs.sendMessage(id, { cmd: 'protonRead', id: messageId, conversationId, before });
      } catch (e) {
        if (PAGE_CHANGED.test(e.message) && Date.now() < deadline) continue;
        throw e;
      }
      if (!res?.ok) throw new Error(res?.error ?? 'Could not read the email from Proton');
      lastMarker = res.marker;
      lastId = messageId;
      return res;
    }
  } finally {
    scheduleClose();
  }
}
