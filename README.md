# Unread Mail

A Chrome extension (Manifest V3) that shows unread mail from several accounts in one
full tab. Click an email to read it, mark it read or unread, or delete it (moves it to
Trash or Deleted Items), without opening the webmail site.

- **Gmail** via the Gmail API and **Outlook/Hotmail** via Microsoft Graph.
- **iCloud, Yahoo and AOL** via IMAP, through a small local helper (Chrome
  native messaging) with app-specific passwords kept in the macOS Keychain.
- **Proton** (free plan) through the mail.proton.me session signed in in Chrome:
  unread list, mark read/unread, delete and Recently read. Bodies are end-to-end
  encrypted, so they are read from a background Proton Mail tab after Proton has
  decrypted them; the extension never handles Proton keys.

Any number of accounts per provider.

## Layout

```
┌rail┬──────── list (35%) ────────┬──────────── reader (65%) ────────────┐
│All4│ (All accounts)(anna·1)(…)  │ [Mark read] [Delete]    [Open in …]  │
│ G 1│ ☐ 4 unread                 │ Subject                               │
│ O  │ i  Apple ●         11:52   │ From / To / Date                      │
│ i 2│    Your receipt from Apple │ ───────────────────────────────────── │
│ Y 1│    anna@icloud.com         │                                       │
│ A  │ G  Yahoo           11:40   │   email body (sandboxed)              │
│    │    …                       │                                       │
│ +  │                            │                                       │
└────┴────────────────────────────┴───────────────────────────────────────┘
```

- **Provider rail:** "All" plus one icon per provider, each with its unread count.
  Providers with nothing unread are faded; one with a signed-out account shows an
  amber dot. **+** at the bottom adds an account.
- **One list, newest first:** every unread email in the current view, whichever
  account it arrived in, with a blue dot on emails that came in since you last left
  the tab. Chips at the top narrow the list to one account (in "All", only accounts
  with unread mail or a problem get a chip).
- **Account view** (click a chip): the account's address, its ⋯ menu (refresh, sign
  in again, hide, remove) and **Recently read**, which loads the last 10 read inbox
  emails on demand.
- **Selecting:** hovering a row turns its provider icon into a checkbox. Tick emails
  (shift-click for a range) or use the select-all box, then **Mark read**; this works
  across accounts. When more unread mail exists than is listed, **Select all N**
  extends it to every unread inbox email in the view.
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
| iCloud / Yahoo / AOL | IMAP via `helper/unread_mail_imap.py`. Listing uses `EXAMINE` (read-only) and `SEARCH UNSEEN`, fetching only From/Subject/Date of the newest 30; bodies use `BODY.PEEK[]` on click; delete is `UID MOVE` to the Trash folder. |
| Proton | Private web-app API on `mail.proton.me/api` with the session's `AUTH-<UID>` cookie, `x-pm-uid` and a current `x-pm-appversion` (from `/assets/version.json`); a declarativeNetRequest rule sets `Origin`/`Referer` to mail.proton.me. Inbox is label `0`, delete moves to Trash (label `3`). An expired session is renewed with the refresh cookie once. Bodies: a background mail.proton.me tab opens the email and `src/content/proton-reader.js` copies the body Proton rendered (embedded images as data: URLs); the tab is reused and closed after 3 idle minutes. |
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
src/providers/proton.js  Proton adapter (signed-in web session)
src/providers/proton-tab.js  background Proton tab used to read decrypted bodies
src/content/proton-reader.js content script on mail.proton.me that copies a rendered body
src/native.js            native messaging client for the helper
helper/                  IMAP helper and its installer
src/app/                 full-tab UI (app.html / app.css / app.js / render-email.js)
src/vendor/              DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0)
icons/providers/         provider icons used in the rail and list
```

Each provider adapter implements `identify`, `fetchSummary`, `getMessage`,
`getAttachment`, `setRead` and `trash`.
