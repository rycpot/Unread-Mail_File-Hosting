// Runs on mail.proton.me whenever you have it open. It passes the extension
// Proton's persisted-session entries ("ps-<localID>" in this site's
// localStorage). Their key material is still encrypted: it can only be
// unlocked with a key the Proton server hands out to the signed-in session,
// which is what lets the extension decrypt emails without opening Proton.

(() => {
  function collect() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const m = key?.match(/^ps-(\d+)$/);
      if (!m) continue;
      try {
        const v = JSON.parse(localStorage.getItem(key));
        if (v?.UID && v.blob) {
          items.push({ localID: Number(m[1]), UID: v.UID, blob: v.blob, payloadVersion: v.payloadVersion || 1 });
        }
      } catch {}
    }
    return items;
  }

  let last = '';
  function send() {
    const items = collect();
    const sig = JSON.stringify(items);
    if (!items.length || sig === last) return;
    last = sig;
    chrome.runtime.sendMessage({ cmd: 'protonSessions', items }).catch(() => {});
  }

  send();
  // Proton writes the entry after signing in; pick it up when it appears.
  addEventListener('storage', send);
  document.addEventListener('visibilitychange', send);
  setTimeout(send, 5000);
})();
