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
5. **Audience → Publishing status**: click **Publish app** so it is **In production**.
   Do **not** submit for verification. (In *Testing* status, Google expires access
   every 7 days.) Unverified apps are allowed for personal use under 100 users.
6. **Clients → Create client**:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://gnkolniepchhhfhnopbhgbnedkplhjjj.chromiumapp.org/`
   - Leave *Authorized JavaScript origins* empty.
7. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). No client secret is
   used.

When you add each Gmail account you will see **"Google hasn't verified this app"**.
Click **Advanced → Go to Unread Mail (unsafe)**, then tick the Gmail permission box.
This is expected for a personal, unverified app: the app is yours.

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

## 3. Paste the IDs

Edit `src/config.js`:

```js
export const GOOGLE_CLIENT_ID = '1234-abc.apps.googleusercontent.com';
export const MICROSOFT_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
```

Then click the reload icon on the extension's card in `chrome://extensions`.

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| "client ID is not set" | Step 3 was not done, or the extension was not reloaded. |
| `redirect_uri_mismatch` (Google) | The redirect URI in step 1.6 must match exactly, with the trailing `/`. |
| "Gmail access was not granted" | On the consent screen, tick the Gmail permission checkbox. |
| Account keeps showing "Signed out" | Sign in to that account on mail.google.com / outlook.live.com in this Chrome profile, then click **Sign in**. |
| Extension ID differs from the one above | `manifest.json`'s `key` was changed; restore it, or update both redirect URIs to the new ID. |
