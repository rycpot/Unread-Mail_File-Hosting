# Setup

One-time setup, about 15 minutes. You create **one** Google OAuth client and **one**
Microsoft app registration; they serve all of your Gmail and Hotmail accounts.

## 0. Install and load the extension

1. Paste into Terminal (macOS; Linux works too):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/rycpot/Unread-Mail_File-Hosting/claude/blissful-faraday-8ykg9h/install.sh | sh
   ```

   It downloads the extension into `~/UnreadMail` and installs the local helper,
   which iCloud, Yahoo and AOL use and which installs updates for you. Run it
   whatever accounts you plan to connect.
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked**, press **⌘⇧G**, paste (**⌘V**, the installer copied the
   path), press Return, then **Select**.
4. Check the ID shown on the card is:

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

   *Testing vs. In production:* in **Testing**, Google cancels the Gmail permission
   after 7 days, so every Gmail account shows **Signed out** weekly until you click
   **Sign in**. To stop that, publish the app once ("In production", below). Do not
   submit it for verification either way.
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

### Publishing (stops the weekly Gmail sign-in)

Google only lets an app with Gmail access leave Testing when Branding has a home
page, a privacy policy and an authorized domain. This repository includes both pages
(`docs/index.html` and `docs/privacy.html`), served free by GitHub Pages:

1. On GitHub: **Settings → Pages → Build and deployment**: Source **Deploy from a
   branch**, branch `claude/blissful-faraday-8ykg9h`, folder **/docs**, Save. After a
   minute the pages are at `https://rycpot.github.io/Unread-Mail_File-Hosting/` and
   `…/privacy.html`.
2. Google Cloud → **Google Auth Platform → Branding**:
   - Application home page: `https://rycpot.github.io/Unread-Mail_File-Hosting/`
   - Application privacy policy link: `https://rycpot.github.io/Unread-Mail_File-Hosting/privacy.html`
   - Authorized domains: `rycpot.github.io`
   - Save. If the console asks you to verify ownership of the domain, use
     [Google Search Console](https://search.google.com/search-console) with a
     **URL prefix** property for the home page address above and the **HTML file**
     method: add the file it gives you to `docs/` (or ask for it to be added), then
     click **Verify**.
3. **Audience → Publish app → Confirm.** Ignore any offer to submit for verification.
4. In the extension, click **Sign in** on each Gmail account once. From then on the
   permission no longer expires after 7 days (only if you revoke it, change your
   Google password, or don't use it for six months).

You will still see "Google hasn't verified this app" when signing in; that is
expected for a personal app and harmless.

## 2. Microsoft (Hotmail / Outlook.com)

1. Go to <https://entra.microsoft.com/> (sign in with any Microsoft account) →
   **Applications → App registrations → New registration**.
   - Name: `Unread Mail`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Single-page application (SPA)**,
     URI `https://gnkolniepchhhfhnopbhgbnedkplhjjj.chromiumapp.org/`
2. Click **Register** and copy the **Application (client) ID**.
3. **API permissions → Add a permission → Microsoft Graph → Delegated**: add
   `Mail.ReadWrite`, `Mail.Send` and `offline_access` (`User.Read` is there by
   default). Personal accounts consent for themselves; no admin consent is needed.
   Accounts connected before `Mail.Send` was added are asked to approve sending
   once, the first time they send.

No client secret is created: the extension uses the PKCE flow.

> If you ever get error `AADSTS9002326` or `AADSTS9002327`, the redirect URI is on the
> wrong platform. It must be under **Single-page application**, not *Web* or
> *Mobile and desktop*.

## 3. Enter the IDs

Click the toolbar icon to open the app tab, then the **gear icon → OAuth client IDs**
at the bottom (it opens by itself on first run). Paste the Google client ID and the Microsoft
Application (client) ID, then click **Save IDs**.

The IDs are saved inside the extension, so updating its files (ZIP or `git pull`)
never loses them. (`src/config.js` still accepts them as a fallback; IDs found
there are copied into the extension's storage automatically.)

## Updating the extension

The app checks this repository's branch every 6 hours (and at Chrome start). When
there is a newer version, a bar at the top shows it with what changed:

- **Install update** has the IMAP helper download the new version from GitHub,
  replace the files in your extension folder (keeping `src/config.js`), refresh
  itself, and reload the extension. The app tab reopens with "Updated to version …".
- **Later** hides the bar until the next version. **Settings → Check for updates**
  checks straight away.

This needs the helper, which the installer from step 0 sets up (it also records
where your extension folder is).

macOS does not let the helper change files in **Downloads, Documents or Desktop**.
If the extension folder is in one of those, the installer moves it to
`~/UnreadMail` and leaves a link at the old path, so Chrome and your
accounts carry on unchanged. Don't delete that link: Chrome loads the extension
through it.

Manual update (always works): run the install command from step 0 again, then
click reload ↻ on the extension card in `chrome://extensions`. It updates the
existing folder wherever it is and keeps `src/config.js`.

Installed from a downloaded ZIP instead? Run the install command once. It looks up
the folder Chrome actually loads the extension from (in Chrome's profile settings),
updates that copy, and sets up the helper, so one-click updates work from then on.

Updating never touches your accounts, settings, sign-ins or cached mail: they are in
Chrome's storage for this extension, not in its folder. Never **Remove** the
extension to update it: removing it deletes that data.

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
email, and the last 10 read emails when you open *Recently read*. Listed emails
and their attachments are downloaded for the offline cache (see §10); the helper
itself keeps nothing on disk.

**Push:** while Chrome is running, the helper also keeps one connection per
account open in IMAP IDLE mode, so new mail (or mail read elsewhere) shows up
within about a second, without repeated sign-ins. It stops when Chrome quits.

### The helper

The installer from step 0 already set it up: it copies the helper to
`~/Library/Application Support/UnreadMail/`, registers it with Chrome and runs a
self-test. Updates refresh it automatically. To set it up again by hand:
`sh ~/UnreadMail/helper/install.sh`, then reload the extension.

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
- The extension unlocks your Proton keys in memory (the app tab and Chrome's
  background worker for the extension; the keys are never saved to disk) and
  decrypts the body, embedded images and attachments.
- Decrypted emails and attachments are kept in the offline cache on this computer,
  like other accounts' mail (see §10). Clear it with **Settings → Offline cache →
  Clear**.

Because the extension handles your Proton keys, only run code you trust (this
repository), and remove the account with **⋯ → Remove account** if you stop using it.

If you sign out of Proton, the account shows *Signed out*; sign in at
mail.proton.me again and click **Sign in** in the app.

### Opening a mailbox on the web, and the default account

Double-click an account's chip (at the top of the list) to open that mailbox on the
provider's website in a new tab; double-click a provider's icon in the left rail to
open its **default** account. The default is the first chip in the provider's view:
drag the chips to reorder them, or use **⋯ → Make default** on an account. The
account menu also has **Open mailbox**.

- Gmail opens the exact account (when several are signed in to Chrome); Proton opens
  the signed-in session's mailbox.
- Outlook.com shows one signed-in account at a time; the link suggests the right
  one, but you may need to switch accounts there. iCloud, Yahoo and AOL open their
  webmail as signed in.

## 7. Notifications

**Settings → Notifications → New mail notifications** and **Sound** can be switched
independently; **Test** shows a sample notification and plays the chime.

On macOS, Chrome's notifications also need to be allowed in **System Settings →
Notifications → Google Chrome**. The banner style you choose there (Temporary or
Persistent) is asked once after your first account is connected, and can be changed
under **Settings → Notifications → Banner style**; keep the two the same:

- **Persistent:** one alert; the same banner then counts new mail silently until you
  close it, after which the next email alerts again straight away.
- **Temporary:** mail arriving after a banner has gone gets a new banner; chimes are
  at least 20 seconds apart.

## 8. Writing email

**Compose** (top bar) opens a window at the bottom right; the arrows button makes it
fill the app. **Reply**, **Reply all** and **Forward** are in the reader's toolbar.

- **From** starts as the account you are viewing (or the one the open email belongs
  to); the dropdown lists every account. Check it before sending.
- To/Cc/Bcc suggest addresses from mail you have seen and sent (kept on this
  computer only).
- Formatting: bold, italic, alignment, bulleted and numbered lists, links, undo and
  redo (⌘B, ⌘I, ⌘K, ⌘Z, ⇧⌘Z; ⌘↩ sends). Anything pasted comes in as plain text.
- Images dropped or pasted into the text go inline, scaled down to 1920 px on the
  longest side and shown at most 600 px wide. Other files, or anything dropped on
  the attach area (paperclip), are attached as they are; 25 MB in total.
- Emails are sent without a font of their own, so each recipient's mail app shows
  them in its usual font.
- Drafts save to the account's Drafts folder as you type and when you close the
  window; reopen them from **Drafts** at the bottom of the list.
- **Send** waits for the undo delay (Settings → Writing → Undo send: 5, 10, 20 or 30 s). The
  bar at the bottom counts down in every view, even if the app tab is closed;
  **Undo** reopens the email. If Chrome quits during the countdown the email is
  not sent and stays in Drafts.
- For iCloud, Yahoo and AOL, set **Settings → Writing → Your name** (Gmail, Outlook and
  Proton use the name set in each service). They send through the same app
  passwords (SMTP), so the helper needs updating once (the update does it).
- Proton: emails to Proton addresses are end-to-end encrypted with the recipient's
  key; other addresses get a normal email, as in Proton's web app. Because this
  uses Proton's private web API, send yourself a test first.

## 9. Opening attachments

Every attachment opens in the app. PDFs, Word (.docx) and Excel (.xlsx, .xls, .ods)
files, password-protected ones included, CSV, images and any text file are shown;
videos (MP4, MOV, WebM, MKV) and audio (MP3, M4A, WAV, FLAC, Ogg, Opus) play there
(Space play/pause, M mute, F full screen; the 1× button changes speed);
other files show a Download button (nothing downloads by itself). The arrows (or ←/→)
move between an email's attachments; Download and Print (⌘P) are at the top right.
Old .doc files are not previewed.

## 10. Offline cache

Every email the app lists (unread, Recently read, Sent, Drafts and Spam) is
downloaded in the background with its images and attachments (videos over
50 MB only when you open them) as soon as it appears, so it opens instantly, also without a connection.
The Recently read, Sent, Drafts and Spam lists are saved too, so they open at once
and refresh behind the scenes. Downloading does not
mark anything read.

- It is stored in this Chrome profile on disk (IndexedDB), readable by anyone with
  access to your Mac account, like Chrome's own cache. Proton emails are stored
  decrypted.
- **Settings → Offline cache** shows its size and sets the limit (1 GB by default);
  when full, the least recently opened items go first. **Clear** empties it (it is
  then downloaded again).
- Emails no longer listed for 14 days are removed, and removing an account removes
  its cached mail.

## 11. Uploading files (Catbox, x02, ImgLink)

The three icons above **+** in the left rail upload files and give you links to
share: **ImgLink** (top), **x02** and **Catbox**. Click one and the email area becomes a drop
zone: drop files anywhere on it, or click it to choose files. You can also paste
(⌘V): right-click an image on any web page → **Copy image**, then paste in the
panel. The service fetches the original file from its address (keeping its format,
animation and name); if it can't (a site behind a login or blocking outside
downloads), the pasted picture is uploaded instead, as PNG. Pasting a copied link
to a file (e.g. **Copy image address**) uploads that file, and a screenshot copied
to the clipboard (⌘⌃⇧4) uploads too. x02 only accepts image links. ImgLink can't
fetch links at all, so for it a copied link is always downloaded here (below).

If Catbox or x02 can't fetch a link (for example a site whose security certificate
is set up incompletely, which Chrome copes with but their servers don't), the row
offers **Download it here**: the app then downloads the file itself and uploads it.
The first time, Chrome asks to let the extension read data on all websites; it is
only used for these downloads. After that it happens automatically. Each file gets its
own link; when the uploads finish the links are copied to the clipboard (one per
line). Click any link (or the copy icon) to copy it again. Click a preview or name to
open the file in the app's viewer (← / → move through the list, Esc closes it); the
arrow icon opens it in a new tab instead.
**Recent uploads** lists the last 100 with a preview (the image itself, or a tile
with the file type), size, and date and time. For x02 the list comes from your
account, so it also shows files uploaded on the x02 website; the same goes for
ImgLink once its API key is set. For Catbox, and ImgLink without a key, it lists the
uploads made from here (there is no way to list them). Image previews are
small thumbnails kept on this computer: made from your file when you upload, or
from one download of the image otherwise, so they show at once afterwards. Esc, the ✕ or the
same icon closes the panel and brings the email back.

- **Catbox:** up to 200 MB per file; .exe, .scr, .cpl, .doc* and .jar are refused.
  Uploads are anonymous unless you add your userhash (catbox.moe → Manage
  account) in **Settings → Uploads → Catbox userhash**. Files uploaded with the
  userhash can be deleted from the list (trash icon); anonymous uploads can't be.
- **x02:** needs an API key from the x02 dashboard, in **Settings → Uploads → x02
  API key**. Up to 200 MB (512 MB on Pro). **Delete after** can make a link expire
  (1 hour to 30 days). The trash icon deletes a file from your x02 account. Two small
  meters under the title show your storage (used / limit) and today's uploads against
  your plan's daily limit.
- **ImgLink:** images only (JPG, PNG, GIF, WebP, SVG, BMP, ICO, TIFF, AVIF), up to
  25 MB anonymously or 50 MB with an API key. Without a key ImgLink may limit uploads
  (about 10 per 10 minutes); with a key, 100 an hour.
  If you hit the limit, the row says how many minutes to wait. Every upload is sent as private, so it is never in ImgLink's public
  gallery or search. Uploads are anonymous unless you add an API key (imglink.cc →
  Dashboard → API Keys) in **Settings → Uploads → ImgLink API key**. Files uploaded
  with the key can be deleted from the list (trash icon); anonymous uploads can't be.
  With the key, the panel also shows two small meters: your ImgLink storage (used /
  limit) and uploads this hour (website and app uploads share 100 an hour).
- Uploaded files are public to anyone with the link. The userhash and API keys are
  kept in this Chrome profile and only sent to catbox.moe, up.x02.me and imglink.cc.
- Keep the app tab open until uploads finish (Chrome warns if you close it).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The helper is not installed" | Run the install command from step 0, then reload the extension. |
| iCloud/Yahoo/AOL "rejected the email or app password" | Use an app-specific password, not your normal one. For iCloud, sign in with the @icloud.com address. |
| Proton shows "request failed" after a Proton update | Open mail.proton.me once, then **Refresh**; the extension re-reads Proton's current app version. If it persists, report the error text. |
| No notification appears | Check Settings → Notifications → New mail notifications, then macOS System Settings → Notifications → Google Chrome, and that Focus / Do Not Disturb is off. |
| "client ID is not set" | Enter the IDs under the gear icon → OAuth client IDs (step 3). |
| `redirect_uri_mismatch` (Google) | The redirect URI in step 1.6 must match exactly, with the trailing `/`. |
| "Gmail access was not granted" | On the consent screen, tick the Gmail permission checkbox. |
| Account keeps showing "Signed out" | Sign in to that account on mail.google.com / outlook.live.com in this Chrome profile, then click **Sign in**. |
| Extension ID differs from the one above | `manifest.json`'s `key` was changed; restore it, or update both redirect URIs to the new ID. |
