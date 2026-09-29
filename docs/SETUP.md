# Setup

One-time setup, about 15 minutes. You create **one** Google OAuth client and **one**
Microsoft app registration; they serve all of your Gmail and Hotmail accounts.

## 0. Load the extension

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this repository's folder.
3. Check the ID shown on the card is:

   ```
   gnkolniepchhhfhnopbhgbnedkplhjjj
   ```

   It is fixed by the `key` in `manifest.json`, so it is the same on every machine.
   The OAuth redirect URL used below is therefore:

   ```
   https://gnkolniepchhhfhnopbhgbnedkplhjjj.chromiumapp.org/
   ```

## 1. Google (Gmail)

1. Go to <https://console.cloud.google.com/> and create a project, e.g. `unread-mail`.
2. **APIs & Services → Library**: search **Gmail API** and click **Enable**.
3. **Google Auth Platform → Branding** (older consoles: *OAuth consent screen*):
   - App name: anything, e.g. `Unread Mail`; support email: your address.
   - **Audience**: user type **External**.
4. **Data Access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/gmail.modify`, save.
5. **Audience → Test users → Add users**: add each Gmail address you will connect.
   Leave the publishing status on **Testing**.

   *Why not "In production"?* Because Gmail scopes are restricted, the console only
   allows **Publish app** once Branding also has a home page, a privacy policy link
   and an authorized domain that you own. Testing mode needs none of these. Its one
   downside is that Google may expire the grant after 7 days, in which case the
   account shows **Signed out** and one click on **Sign in** fixes it. If that
   becomes annoying, fill in those Branding fields and publish. Do not submit for
   verification either way.
6. **Clients → Create client**:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://gnkolniepchhhfhnopbhgbnedkplhjjj.chromiumapp.org/`
   - Leave *Authorized JavaScript origins* empty.
7. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). No client secret is
   used.

When you add each Gmail account you will see **"Google hasn't verified this app"**.
Click **Advanced → Go to Unread Mail (unsafe)**, then tick the Gmail permission box.
This is expected for a personal, unverified app: the app is yours. (In Testing mode
only addresses listed as test users can sign in; others get "Access blocked".)

## 2. Microsoft (Hotmail / Outlook.com)

1. Go to <https://entra.microsoft.com/> (sign in with any Microsoft account) →
   **Applications → App registrations → New registration**.
   - Name: `Unread Mail`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Single-page application (SPA)**,
     URI `https://gnkolniepchhhfhnopbhgbnedkplhjjj.chromiumapp.org/`
2. Click **Register** and copy the **Application (client) ID**.
3. **API permissions → Add a permission → Microsoft Graph → Delegated**: add
   `Mail.ReadWrite` and `offline_access` (`User.Read` is there by default).
   Personal accounts consent for themselves; no admin consent is needed.

No client secret is created: the extension uses the PKCE flow.

> If you ever get error `AADSTS9002326` or `AADSTS9002327`, the redirect URI is on the
> wrong platform. It must be under **Single-page application**, not *Web* or
> *Mobile and desktop*.

## 3. Enter the IDs

Click the toolbar icon to open the app tab, then the **gear icon → OAuth client IDs**
(it opens by itself on first run). Paste the Google client ID and the Microsoft
Application (client) ID, then click **Save IDs**.

The IDs are saved inside the extension, so updating its files (ZIP or `git pull`)
never loses them. (`src/config.js` still accepts them as a fallback; IDs found
there are copied into the extension's storage automatically.)

## Updating the extension

- **ZIP:** download the branch ZIP, copy its files over your existing folder,
  then click reload ↻ on the extension card in `chrome://extensions`.
- **git:** `git pull`, then reload ↻.

Never **Remove** the extension to update it: removing it deletes its saved data
(client IDs, sign-ins and cached mail).

## 4. Add your accounts

Click the toolbar icon to open the app tab. For each account:

- Gmail: **Gmail → Add account**, choose the account, approve.
- Outlook: **Outlook → Add account**, choose the account, approve.

Repeat for each of the 3 Gmail and 2 Hotmail accounts. In the Google/Microsoft
account picker, pick the right one (or "Use another account").

### Staying signed in

Access tokens last about an hour and are renewed silently in the background. For
this to keep working, **stay signed in to all accounts in this Chrome profile**
(mail.google.com / outlook.live.com multi-account sign-in is enough). If renewal
fails, that account shows **Signed out** with a **Sign in** button; its last known
emails stay visible until you sign in again.

## 5. iCloud, Yahoo and AOL (IMAP helper)

These accounts use IMAP through a small local helper
(`helper/unread_mail_imap.py`, Python standard library only). Chrome starts it
on demand; it is not a server and does not run when Chrome is closed. It only
ever reads unread mail (headers of the newest 30), a body when you open an
email, and the last 10 read emails when you open *Recently read*. Nothing is
cached on disk.

**Push:** while Chrome is running, the helper also keeps one connection per
account open in IMAP IDLE mode, so new mail (or mail read elsewhere) shows up
within about a second, without repeated sign-ins. It stops when Chrome quits.

### Install the helper (once, and again after updates)

```bash
sh ~/Downloads/unread-emails-notifier/helper/install.sh
```

It copies the helper to `~/Library/Application Support/UnreadMail/`, registers
it with Chrome, and runs a self-test. Then reload the extension.

### Create app-specific passwords

Your normal password will not work over IMAP; each service issues app passwords:

| Service | Where | Username to use |
|---|---|---|
| iCloud | <https://account.apple.com> → Sign-In and Security → **App-Specific Passwords** | your **@icloud.com** address (not a non-Apple Apple ID email) |
| Yahoo | <https://login.yahoo.com/account/security> → **Generate app password** | your Yahoo address |
| AOL | <https://login.aol.com/account/security> → **Generate app password** | your AOL address |

### Add the accounts

In the app tab: **iCloud / Yahoo / AOL → Add account**, enter the address and
the app password, **Connect**. The helper signs in once to check it, then saves
the password in the macOS **Keychain** (item `unread-mail-imap`). The extension
itself never stores it. **Remove account** deletes the Keychain item too.

## 6. Proton (free plan)

Proton's free plan has no IMAP, so the extension uses the Proton session you are
signed in to in this Chrome profile.

1. Sign in at <https://mail.proton.me> in Chrome, with **Keep me signed in** on.
2. In the app: **+ → Proton**. Every Proton account signed in there is added.

What works: unread count and list, mark read/unread (one, several or all), delete
(moves to Trash) and Recently read.

**Reading emails:** Proton encrypts bodies end-to-end. The extension decrypts them
itself, the same way Proton's web app does, without opening any Proton tab:

- While mail.proton.me is open, a small script passes the extension Proton's saved
  session entry. It is still encrypted; only the Proton server can unlock it, and
  only for your signed-in session. So **open mail.proton.me once** after connecting
  (and again if you sign out and in), with **Keep me signed in** on.
- When you open an email, the extension unlocks your Proton keys in the app tab's
  memory (never saved to disk; gone when the tab closes) and decrypts the body,
  embedded images and attachments.

Because the extension handles your Proton keys, only run code you trust (this
repository), and remove the account with **⋯ → Remove account** if you stop using it.

If you sign out of Proton, the account shows *Signed out*; sign in at
mail.proton.me again and click **Sign in** in the app.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The IMAP helper is not installed" | Run `helper/install.sh` (section 5), then reload the extension. |
| iCloud/Yahoo/AOL "rejected the email or app password" | Use an app-specific password, not your normal one. For iCloud, sign in with the @icloud.com address. |
| Proton shows "request failed" after a Proton update | Open mail.proton.me once, then **Refresh**; the extension re-reads Proton's current app version. If it persists, report the error text. |
| "client ID is not set" | Enter the IDs under the gear icon → OAuth client IDs (step 3). |
| `redirect_uri_mismatch` (Google) | The redirect URI in step 1.6 must match exactly, with the trailing `/`. |
| "Gmail access was not granted" | On the consent screen, tick the Gmail permission checkbox. |
| Account keeps showing "Signed out" | Sign in to that account on mail.google.com / outlook.live.com in this Chrome profile, then click **Sign in**. |
| Extension ID differs from the one above | `manifest.json`'s `key` was changed; restore it, or update both redirect URIs to the new ID. |
