# Unread Mail

A Chrome extension (Manifest V3) that shows unread mail from several accounts in one
full tab. Click an email to read it, mark it read or unread, or delete it (moves it to
Trash or Deleted Items), without opening the webmail site.

- **Gmail** via the Gmail API and **Outlook/Hotmail** via Microsoft Graph.
- **iCloud, Yahoo and AOL** via IMAP, through a small local helper (Chrome
  native messaging) with app-specific passwords kept in the macOS Keychain.
- **Proton** (free plan, session based) is planned.

Any number of accounts per provider.

## Layout

```
┌──────────── 35% ─────────────┬──────────────── 65% ────────────────┐
│ GMAIL             + Add      │ [Mark read] [Delete]   [Open in …]  │
│ ▾ me@gmail.com           3   │ Subject                              │
│    Sender · subject · time   │ From / To / Date                     │
│ ▾ work@gmail.com  ●      1   │ ─────────────────────────────────── │
│    Signed out · Sign in      │                                      │
│    (last known mail stays)   │   email body (sandboxed)             │
│ OUTLOOK           + Add      │                                      │
│ ▸ me@hotmail.com         2   │                                      │
└──────────────────────────────┴──────────────────────────────────────┘
```

- Accounts are grouped by provider, with their unread emails listed under each account
  (sender, time and subject; accounts with no unread mail show only their header).
- Tick emails, or use an account's select-all box, then **Mark read** to clear them
  in one request. Shift-click ticks a range. When an account has more unread mail
  than is listed, **Select all N unread** extends the selection to every unread
  inbox email.
- Providers are shown as coloured pills, and each account's address as a pill in
  its own colour.
- Accounts never disappear on their own. If one signs out or fails to refresh, it
  shows a notice and keeps its last known emails. Only **⋯ → Remove account**
  deletes one.
- **⋯ → Hide** hides an account and leaves it out of the badge count. You can
  still reach it through *Settings → Show hidden accounts*.
- **Recently read** under each account (collapsed by default) loads the last 10
  read inbox emails on demand, so they can be reopened, marked unread or deleted.
- The toolbar badge shows the total unread count across visible accounts.

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
| Sign-in | `chrome.identity.launchWebAuthFlow`, so several accounts per provider are supported. Google uses the token flow; Microsoft uses auth code + PKCE. Renewal is silent: a refresh token (Microsoft), then `prompt=none` + `login_hint`. |
| Polling | A `chrome.alarms` alarm, every 1 to 15 minutes (set in Settings). State lives in `chrome.storage.local`. |
| Email safety | Each email is cleaned with DOMPurify, rendered in an iframe that cannot run scripts, and restricted by a CSP that blocks all network loads. Remote images are blocked until you choose *Show images*. |

### Files

```
manifest.json
src/background.js        service worker: alarm polling, badge, opens the app tab
src/sync.js              fetch summaries, record status per account
src/auth.js              OAuth flows and silent token renewal
src/http.js              authorised fetch with one renew-and-retry on 401
src/storage.js           chrome.storage.local layout
src/providers/gmail.js   Gmail API adapter
src/providers/outlook.js Microsoft Graph adapter
src/providers/imap.js    iCloud / Yahoo / AOL adapter (talks to the helper)
src/native.js            native messaging client for the helper
helper/                  IMAP helper and its installer
src/app/                 full-tab UI (app.html / app.css / app.js / render-email.js)
src/vendor/              DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0)
```

Each provider adapter implements `identify`, `fetchSummary`, `getMessage`,
`getAttachment`, `setRead` and `trash`. The session-based providers in phase 2
will implement the same interface.
