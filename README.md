![Image](https://files.catbox.moe/m39tfo.png)
![Image](https://files.catbox.moe/e76gaz.png)
![Image](https://files.catbox.moe/99ibyp.png)
# Unread Mail

A Chrome extension (Manifest V3) that shows unread mail from several accounts in one
full tab. Click an email to read it, mark it read or unread, or delete it (moves it to
Trash or Deleted Items), without opening the webmail site.

- **Gmail** via the Gmail API and **Outlook/Hotmail** via Microsoft Graph.
- **iCloud, Yahoo and AOL** via IMAP, through a small local helper (Chrome
  native messaging) with app-specific passwords kept in the macOS Keychain. New
  mail arrives by push (IMAP IDLE) within about a second.
- Select several emails (or all) to mark them read or move them to Trash (with a
  confirmation). Each account, and every **All** view combined, has collapsed
  **Recently read** and **Spam** sections pinned at the bottom (they open upwards); Spam lists unread spam
  only, with its count, and it can be read, deleted or marked *Not spam*.
- **Write email** from any account: compose, reply, reply all and forward with a
  minimal rich-text editor, inline images, attachments, address suggestions,
  autosaved drafts and undo send.
- **Attachments open in the app**: PDFs (with passwords), Word, Excel, CSV, images,
  text, video and audio, with Print.
- **Proton** (free plan) through the mail.proton.me session signed in in Chrome:
  unread list, mark read/unread, delete and Recently read. Bodies and attachments
  are end-to-end encrypted and are decrypted inside the extension with OpenPGP.js,
  with no Proton tab opened.
- **File uploads** to Catbox and x02: the icons above **+** in the left rail open a
  drop zone (or paste a copied image, link or screenshot with ⌘V); each file gets a link that is shown and copied to the clipboard. The
  last 100 uploads are listed with previews, dates and delete (x02's list comes
  from the account).
- **Offline cache**: every email the app lists (unread, Recently read, Sent,
  Drafts, Spam) is downloaded in the background with its images and attachments,
  so it opens instantly. Stored on this computer, 1 GB by default (Settings).

Any number of accounts per provider.

## Install (macOS)

Paste into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/rycpot/unread-emails-notifier/claude/blissful-faraday-8ykg9h/install.sh | sh
```

It downloads the extension into `~/UnreadMail` and installs its small local helper.
Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → pick
`~/UnreadMail` (the installer copies the path for you). After that, new versions
show up as a bar at the top of the app and install with one click; running the
command again also updates.

## Setup

See [docs/SETUP.md](docs/SETUP.md). You need one Google OAuth client and one Microsoft
app registration; together they cover all of your accounts. No build step is needed:
load the folder unpacked.

## How it works

| Area | Details |
|---|---|
| Gmail | Scope `gmail.modify`. The unread count comes from `labels/INBOX`. The list is `INBOX` + `UNREAD` messages. Delete means `messages.trash`. Spam: count from `labels/SPAM`, *Not spam* moves `SPAM` → `INBOX`. |
| Outlook | Scope `Mail.ReadWrite`. The unread count comes from `mailFolders/inbox`. Delete moves the message to `deleteditems`. Spam is the `junkemail` folder; *Not spam* moves to `inbox`. Bulk actions use JSON `$batch`. |
| iCloud / Yahoo / AOL | IMAP via `helper/unread_mail_imap.py`. Listing uses `EXAMINE` (read-only) and `SEARCH UNSEEN`, fetching only From/Subject/Date of the newest 30; bodies use `BODY.PEEK[]` on click; delete is `UID MOVE` to the Trash folder. Spam is the folder flagged `\Junk` (else named Junk, Spam, Bulk or Bulk Mail); its unread count comes from `STATUS (UNSEEN)`. |
| Proton | Private web-app API on `mail.proton.me/api` with the session's `AUTH-<UID>` cookie, `x-pm-uid` and a current `x-pm-appversion` (from `/assets/version.json`); a declarativeNetRequest rule sets `Origin`/`Referer` to mail.proton.me. Inbox is label `0`, delete moves to Trash (label `3`), Spam is label `4`. An expired session is renewed with the refresh cookie once. Decryption follows Proton's open-source web client: a content script passes on Proton's persisted-session entry (`ps-<localID>` in mail.proton.me's localStorage, AES-GCM encrypted); it is unlocked with the ClientKey the server gives the signed-in session (`auth/v4/sessions/local/key`), yielding the key password that unlocks the user keys; address keys are unlocked via their signed Token. Bodies (HTML, text or PGP/MIME) and attachments (KeyPackets + data) are then OpenPGP-decrypted. Unlocked keys stay in memory only (the app tab and the background worker). |
| Sign-in | `chrome.identity.launchWebAuthFlow`, so several accounts per provider are supported. Google uses the token flow; Microsoft uses auth code + PKCE. Renewal is silent: a refresh token (Microsoft), then `prompt=none` + `login_hint`. |
| Checking | Gmail, Outlook and Proton: a `chrome.alarms` alarm every 30 s to 15 min (Settings); Gmail reuses already-fetched headers, so a check without new mail is 3 requests (inbox count, unread list, spam count). iCloud, Yahoo and AOL: **push** — while Chrome runs, the helper keeps one IMAP IDLE connection per account (renewed every 25 min) and reports changes, which are refreshed within about a second; they are only re-checked every 10 min as a safety net, or at ≥ 2 min if push is unavailable. State lives in `chrome.storage.local`. |
| Notifications | Routed by the macOS banner style for Chrome, which the user picks once (a required choice after the first account; changeable in Settings). **Persistent:** the first new email alerts at once (notification + soft two-note chime); while that notification stays open, further emails silently update it to "N new emails" with each provider's icon; once it is closed or clicked, the next email alerts again immediately. **Temporary** (macOS default): emails within 8 s of the last banner are merged into it silently, later ones get a fresh banner, and chimes are at least 20 s apart. With notifications off and sound on, chimes are at least 15 s apart. An email counts as new only if it was not listed before and arrived after the newest one already seen (IMAP: by UID); an account's first sync never alerts, and each email alerts at most once. |
| Updates | The service worker compares the installed version with `manifest.json` on this branch every 6 h and shows a bar with the notes from `changes.json`. **Install update** asks the helper (`selfUpdate`) to download the branch ZIP from GitHub over HTTPS, check that it carries the same extension `key`, write it over the extension folder recorded by `install.sh` (keeping `src/config.js`), and re-run `install.sh`; the extension then reloads itself. Data lives in `chrome.storage`, so accounts and settings are kept. |
| Sending | One draft model for all providers. Gmail: the MIME message (`src/compose/mime.js`) is uploaded as a draft (`upload/…/drafts`, multipart with `threadId`) and sent with `drafts.send`. Outlook: `createReply` / `createReplyAll` / `createForward` or a new message, then `PATCH` recipients/body, attachments (≤ 3 MB inline, larger via upload sessions) and `/send`; needs `Mail.Send`. iCloud/Yahoo/AOL: the helper `APPEND`s drafts to Drafts and sends over SMTP with the app password (iCloud: `smtp.mail.me.com:587` STARTTLS; Yahoo/AOL `:465`), then removes the draft and files a copy in Sent where the server does not. Proton: the draft body is OpenPGP-encrypted to the address key, attachments are uploaded as key packets + data + signature, and sending posts a package: Proton recipients get the session keys encrypted to their public key, others go out through Proton as normal email (`src/providers/proton-send.js`). Undo send: the app saves and prepares; the background (`queueSend`) waits the chosen 5–30 s, kept alive and backed by an alarm, then commits. |
| Viewer | `src/app/viewer.js`: every attachment opens in an overlay (arrows move between the email's attachments; downloads are cached for the tab's lifetime). PDF.js (legacy build, scripting off) draws pages on canvases and asks for a password when needed. Password-protected Word/Excel files are decrypted with office-crypto (Agile and Standard encryption). Word via docx-preview and spreadsheets via SheetJS (.xlsx, .xls, .ods, CSV) are converted to HTML, sanitised with DOMPurify and shown in a sandboxed frame. Video and audio play in Chrome's own player with the app's controls (`src/app/media-player.js`: play/pause, seek, time, mute and volume, speed 0.75–2×, full screen; Space/K, M, F); files Chrome can't play (e.g. AVI, WMV) get the Download button. Anything else is shown as text when its content is text (by content, not extension: UTF-8, UTF-16 with BOM or Windows-1252), otherwise a Download button. For iCloud/Yahoo/AOL the helper fetches only the attachment's MIME part (checked against its size). Printing renders a copy into a hidden frame. |
| Caching | `src/cache-db.js`: an IndexedDB database (`unread-mail-cache`, on disk in the Chrome profile; `unlimitedStorage` keeps Chrome from clearing it) with bodies (inline images included), attachments and drafts. After each check the background worker (`src/prefetch.js`) downloads whatever the app lists and is not cached yet: unread, Recently read (10), Spam (20), Sent (5) and Drafts (3) per account (videos over 50 MB are left until opened), the section lists being re-read at most every 15 minutes. It never marks anything read; iCloud/Yahoo/AOL use batched helper commands. Decrypted Proton bodies and attachments are cached like the others. The app reads the cache first (plus a 30-entry memory cache). Entries not listed for 14 days are removed, then the least recently used until the cache fits the limit (Settings: 500 MB, 1 GB, 2 GB or no limit; Clear empties it). Removing an account removes its cache. Each account's Recently read, Sent, Drafts and Spam lists are saved in `chrome.storage.local` (`list/<account>/<kind>`, `src/section-lists.js`), filled by the background refresh, so the sections open at once in every view; opening one also refreshes it. |
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
src/compose/mime.js      MIME message builder (drafts, SMTP, Gmail)
src/app/compose.js       compose window (editor, recipients, attachments, drafts, send)
src/app/contacts.js      address suggestions
src/app/viewer.js        attachment viewer
src/app/media-player.js  video/audio player for the viewer
src/app/uploads.js       Catbox / x02 file uploads (panel, history)
icons/uploads/           Catbox and x02 icons
src/media-types.js       video/audio file types
src/cache-db.js          offline cache (IndexedDB)
src/section-lists.js     saved Recently read / Sent / Drafts / Spam lists
src/prefetch.js          background download of listed emails and attachments
src/message-fetch.js     fetch-through-cache for bodies and attachments
src/providers/proton-send.js  Proton draft/attachment encryption and send packages
src/update.js            update check against this GitHub branch
changes.json             one line per version, shown in the update bar
helper/                  IMAP helper and its installer
src/app/                 full-tab UI (app.html / app.css / app.js / render-email.js)
src/vendor/              DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0), OpenPGP.js 6.3.2 (LGPL-3.0),
                         postal-mime 4.0.0 (MIT-0), PDF.js 6.3.289 (Apache-2.0),
                         docx-preview 0.4.1 (Apache-2.0), JSZip 3.10.2 (MIT),
                         SheetJS CE 0.20.3 (Apache-2.0), office-crypto.js (from the
                         author's Minimal-Spreadsheet-Text-Design-Editor)
icons/providers/         provider icons used in the rail and list
```

Each provider adapter implements `identify`, `fetchSummary`, `getMessage`,
`getAttachment`, `setRead` and `trash`.
