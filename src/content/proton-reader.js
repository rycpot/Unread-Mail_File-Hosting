// Runs on mail.proton.me. When the extension asks, it copies the body of an
// email as Proton itself has rendered it: Proton decrypts the message in its
// own page, so the extension never sees keys, passwords or ciphertext.
// It only answers messages from this extension and never runs on its own.

(() => {
  const WAIT_MS = 25000;
  const STABLE_MS = 600;
  const MAX_INLINE_BYTES = 8 * 1024 * 1024;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Proton renders the message body in a same-origin iframe; pick the largest
  // one that looks like message content.
  function findBodyDocument() {
    const frames = [...document.querySelectorAll('iframe')]
      .map((f) => {
        try {
          return { f, doc: f.contentDocument };
        } catch {
          return null;
        }
      })
      .filter((x) => x?.doc?.body)
      .filter(({ f, doc }) =>
        /content-iframe|message/i.test(`${f.dataset.testid ?? ''} ${f.title ?? ''} ${f.className ?? ''}`)
        || doc.querySelector('.proton-message-content, #proton-root, [id^="proton"]'));
    frames.sort((a, b) => b.doc.body.innerText.length - a.doc.body.innerText.length);
    if (frames[0]) return frames[0].doc;
    // Fallback: a message body rendered without an iframe.
    const inline = document.querySelector('[data-testid="message-content:body"], .message-content');
    return inline ? { documentElement: inline, body: inline, inline: true } : null;
  }

  // The email is open when the address names it or its conversation (Proton
  // groups emails into conversations by default).
  const isOpen = (ids) => ids.some((x) => x && location.href.includes(x));

  // Navigates Proton's single-page app to the email if it is not open yet.
  function openEmail(id, ids) {
    if (isOpen(ids)) return;
    const path = location.pathname.match(/^\/u\/\d+/)?.[0] ?? '/u/0';
    history.pushState({}, '', `${path}/inbox/${id}`);
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  // Embedded images are blob: URLs of this page; turn them into data: URLs so
  // the extension can show them.
  async function inlineImages(root) {
    let budget = MAX_INLINE_BYTES;
    for (const img of root.querySelectorAll('img[src^="blob:"]')) {
      try {
        const blob = await (await fetch(img.src)).blob();
        if (blob.size > budget) continue;
        budget -= blob.size;
        img.src = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(blob);
        });
      } catch {}
    }
  }

  async function read(id, conversationId, before) {
    const ids = [id, conversationId];
    openEmail(id, ids);
    const deadline = Date.now() + WAIT_MS;
    let last = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(250);
      if (!isOpen(ids)) continue;
      const doc = findBodyDocument();
      const html = doc?.body?.innerHTML ?? '';
      // Wait until Proton has finished rendering, and not the previous email.
      if (!html || html === before) continue;
      if (html !== last) {
        last = html;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince < STABLE_MS) continue;
      const clone = doc.documentElement.cloneNode(true);
      await inlineImages(clone);
      const attachments = [...document.querySelectorAll('[data-testid^="attachment-item"], [data-testid*="attachment"] [title]')]
        .map((el) => el.getAttribute('title') || el.textContent.trim())
        .filter(Boolean);
      return { html: clone.outerHTML, marker: html, attachments: [...new Set(attachments)] };
    }
    throw new Error('Proton did not show the email in time');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd === 'protonPing') {
      // Ready once the mail app (not a sign-in or loading page) has loaded.
      const ready = document.readyState === 'complete' && /^\/u\/\d+\//.test(location.pathname);
      sendResponse({ ok: ready, path: location.pathname });
      return;
    }
    if (msg?.cmd !== 'protonRead') return;
    read(msg.id, msg.conversationId, msg.before).then(
      (res) => sendResponse({ ok: true, ...res }),
      (e) => sendResponse({ ok: false, error: e.message }),
    );
    return true;
  });
})();
