![Image](https://files.catbox.moe/lm0jvx.png)
# Unread Mail

A Chrome extension (Manifest V3) that shows unread mail from several accounts in one
full tab. Click an email to read it, mark it read or unread, or delete it (moves it to
Trash or Deleted Items), without opening the webmail site.

- **Gmail** via the Gmail API and **Outlook/Hotmail** via Microsoft Graph.
- **iCloud, Yahoo and AOL** via IMAP, through a small local helper (Chrome
  native messaging) with app-specific passwords kept in the macOS Keychain. New
  mail arrives by push (IMAP IDLE) within about a second.
- **Proton** (free plan) through the mail.proton.me session signed in in Chrome:
  unread list, mark read/unread, delete and Recently read. Bodies and attachments
  are end-to-end encrypted and are decrypted inside the extension with OpenPGP.js,
  with no Proton tab opened.

Any number of accounts per provider.

## Setup

See [docs/SETUP.md](docs/SETUP.md). You need one Google OAuth client and one Microsoft
app registration; together they cover all of your accounts. No build step is needed:
load the folder unpacked.

## How it works

| Area | Details |
|---|---|
| Gmail | Scope `gmail.modify`. The unread count comes from `labels/INBOX`. The list is `INBOX` + `UNREAD` messages. Delete means `messages.trash`. |
| Outlook | Scope `Mail.ReadWrite`. The unread count comes from `mailFolders/inbox`. Delete moves the message to `deleteditems`. |
| iCloud / Yahoo / AOL | IMAP via `helper/unread_mail_imap.py`. Listing uses `EXAMINE` (read-only) and `SEARCH UNSEEN`, fetching only From/Subject/Date of the newest 30; bodies use `BODY.PEEK[]` on click; delete is `UID MOVE` to the Trash folder. |
| Proton | Private web-app API on `mail.proton.me/api` with the session's `AUTH-<UID>` cookie, `x-pm-uid` and a current `x-pm-appversion` (from `/assets/version.json`); a declarativeNetRequest rule sets `Origin`/`Referer` to mail.proton.me. Inbox is label `0`, delete moves to Trash (label `3`). An expired session is renewed with the refresh cookie once. Decryption follows Proton's open-source web client: a content script passes on Proton's persisted-session entry (`ps-<localID>` in mail.proton.me's localStorage, AES-GCM encrypted); it is unlocked with the ClientKey the server gives the signed-in session (`auth/v4/sessions/local/key`), yielding the key password that unlocks the user keys; address keys are unlocked via their signed Token. Bodies (HTML, text or PGP/MIME) and attachments (KeyPackets + data) are then OpenPGP-decrypted. Unlocked keys stay in the app tab's memory only. |
| Sign-in | `chrome.identity.launchWebAuthFlow`, so several accounts per provider are supported. Google uses the token flow; Microsoft uses auth code + PKCE. Renewal is silent: a refresh token (Microsoft), then `prompt=none` + `login_hint`. |
| Checking | Gmail, Outlook and Proton: a `chrome.alarms` alarm every 30 s to 15 min (Settings); Gmail reuses already-fetched headers, so a check without new mail is 2 requests. iCloud, Yahoo and AOL: **push** — while Chrome runs, the helper keeps one IMAP IDLE connection per account (renewed every 25 min) and reports changes, which are refreshed within about a second; they are only re-checked every 10 min as a safety net, or at ≥ 2 min if push is unavailable. State lives in `chrome.storage.local`. |
| Notifications | Routed by the macOS banner style for Chrome, which the user picks once (a required choice after the first account; changeable in Settings). **Persistent:** the first new email alerts at once (notification + soft two-note chime); while that notification stays open, further emails silently update it to "N new emails" with each provider's icon; once it is closed or clicked, the next email alerts again immediately. **Temporary** (macOS default): emails within 8 s of the last banner are merged into it silently, later ones get a fresh banner, and chimes are at least 20 s apart. With notifications off and sound on, chimes are at least 15 s apart. An email counts as new only if it was not listed before and arrived after the newest one already seen (IMAP: by UID); an account's first sync never alerts, and each email alerts at most once. |
| Email safety | Each email is cleaned with DOMPurify, rendered in an iframe that cannot run scripts, and restricted by a CSP that blocks all network loads. Remote images are blocked until you choose *Show images*. |

### Files

```
manifest.json
src/background.js        service worker: alarm polling, badge, opens the app tab
src/sync.js              fetch summaries, record status per account, detect new arrivals
src/notify.js            grouped new-mail notifications and chime
src/offscreen/           offscreen document that plays the chime
src/auth.js              OAuth flows and silent token renewal
src/http.js              authorised fetch with one renew-and-retry on 401
src/storage.js           chrome.storage.local layout
src/providers/gmail.js   Gmail API adapter
src/providers/outlook.js Microsoft Graph adapter
src/providers/imap.js    iCloud / Yahoo / AOL adapter (talks to the helper)
src/providers/proton.js  Proton adapter (signed-in web session)
src/providers/proton-crypto.js  Proton key unlocking and message/attachment decryption
src/content/proton-session.js  passes Proton's encrypted persisted-session entry to the extension
src/native.js            native messaging client for the helper
helper/                  IMAP helper and its installer
src/app/                 full-tab UI (app.html / app.css / app.js / render-email.js)
src/vendor/              DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0), OpenPGP.js 6.3.2 (LGPL-3.0),
                         postal-mime 4.0.0 (MIT-0)
icons/providers/         provider icons used in the rail and list
```

Each provider adapter implements `identify`, `fetchSummary`, `getMessage`,
`getAttachment`, `setRead` and `trash`.
