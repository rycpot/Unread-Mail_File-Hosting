# Unread Mail

A Chrome extension (Manifest V3) that shows unread mail from several accounts in one
full tab. Click an email to read it, mark it read or unread, or delete it (moves it to
Trash or Deleted Items), without opening the webmail site.

**Phase 1 (this version):** Gmail via the Gmail API, Outlook/Hotmail via Microsoft
Graph, with any number of accounts each.
**Phase 2 (planned):** iCloud, Yahoo, AOL and Proton, using the browser's existing
sessions.

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

- Accounts are grouped by provider, with their unread emails listed under each account.
- Accounts never disappear on their own. If one signs out or fails to refresh, it
  shows a notice and keeps its last known emails. Only **⋯ → Remove account**
  deletes one.
- **⋯ → Hide** hides an account and leaves it out of the badge count. You can
  still reach it through *Settings → Show hidden accounts*.
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
src/app/                 full-tab UI (app.html / app.css / app.js / render-email.js)
src/vendor/              DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0)
```

Each provider adapter implements `identify`, `fetchSummary`, `getMessage`,
`getAttachment`, `setRead` and `trash`. The session-based providers in phase 2
will implement the same interface.
