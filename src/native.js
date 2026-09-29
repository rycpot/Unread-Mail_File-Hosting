// Talks to the local IMAP helper (helper/unread_mail_imap.py) over Chrome
// native messaging. One port per request: the helper answers with optional
// progress frames and chunk frames, then a final frame with done: true.

import { AuthRequiredError } from './auth.js';

const HOST = 'com.unreadmail.imap';

export class HelperError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    if (code === 'not_found') this.status = 404;
  }
}

export function callHelper(payload, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      reject(notInstalled(e.message));
      return;
    }
    let chunks = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      fn(value);
    };
    port.onMessage.addListener((msg) => {
      if (msg.progress) onProgress?.(...msg.progress);
      if (msg.chunk) chunks += msg.chunk;
      if (!msg.done) return;
      if (msg.error) {
        const { code, message } = msg.error;
        finish(reject, code === 'auth' ? new AuthRequiredError(message) : new HelperError(message, code));
        return;
      }
      finish(resolve, chunks ? JSON.parse(chunks) : msg.result);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'The IMAP helper stopped unexpectedly';
      finish(reject, /not found|forbidden/i.test(err) ? notInstalled(err) : new HelperError(err, 'helper'));
    });
    port.postMessage(payload);
  });
}

function notInstalled(detail) {
  return new HelperError(
    `The helper is not installed. Run the install command from the README (docs/SETUP.md, step 0) in Terminal, then reload the extension. (${detail})`,
    'not_installed',
  );
}
