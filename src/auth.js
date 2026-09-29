// OAuth for Google and Microsoft via chrome.identity.launchWebAuthFlow, so any
// number of accounts per provider can be connected (getAuthToken only covers the
// account signed into Chrome itself).
//
// Token renewal order, tried silently from the background:
//   1. cached access token while it has > 2 minutes left
//   2. Microsoft only: refresh token
//   3. prompt=none + login_hint=<email>, which succeeds while that account is
//      still signed in to Google / Microsoft in this browser
// If all fail the account is marked "needs sign-in"; its last known mail stays.

import { getAuth, getClientIds, setAuth } from './storage.js';

export class AuthRequiredError extends Error {
  constructor(message = 'Sign-in required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const REDIRECT_URI = chrome.identity.getRedirectURL();
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const MS_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_SCOPES = ['openid', 'offline_access', 'User.Read', 'Mail.ReadWrite'];

async function clientId(provider) {
  const ids = await getClientIds();
  const id = provider === 'google' ? ids.google : ids.microsoft;
  if (!id) {
    const name = provider === 'google' ? 'Google' : 'Microsoft';
    throw new Error(`${name} client ID is not set. Add it under Settings → OAuth client IDs (see docs/SETUP.md).`);
  }
  return id;
}

async function runAuthFlow(url, interactive) {
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive,
      // Let silent flows follow JS redirects instead of aborting on first page load.
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 15000,
    });
  } catch (e) {
    if (interactive) throw e;
    throw new AuthRequiredError(e.message);
  }
  const u = new URL(redirect);
  const params = new URLSearchParams(u.hash ? u.hash.slice(1) : u.search);
  const error = params.get('error') ?? new URLSearchParams(u.search).get('error');
  if (error) {
    const desc = params.get('error_description') ?? new URLSearchParams(u.search).get('error_description');
    if (!interactive || ['interaction_required', 'login_required', 'consent_required', 'account_selection_required'].includes(error)) {
      throw new AuthRequiredError(desc || error);
    }
    throw new Error(desc || error);
  }
  return params;
}

// ---------- Google (implicit flow: access token only, renewed via prompt=none) ----------

async function googleAuthorize({ loginHint, interactive }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: await clientId('google'),
    response_type: 'token',
    redirect_uri: REDIRECT_URI,
    scope: GOOGLE_SCOPES.join(' '),
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account consent' : 'none',
    ...(loginHint && { login_hint: loginHint }),
  });
  const params = await runAuthFlow(url, interactive);
  const accessToken = params.get('access_token');
  if (!accessToken) throw new Error('Google did not return an access token');
  const granted = params.get('scope') ?? '';
  if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) {
    throw new Error('Gmail access was not granted. Tick the Gmail checkbox on the consent screen.');
  }
  return { accessToken, expiresAt: Date.now() + Number(params.get('expires_in') ?? 3600) * 1000 };
}

// ---------- Microsoft (auth code + PKCE, refresh tokens, prompt=none fallback) ----------

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function msToken(body) {
  const res = await fetch(`${MS_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: await clientId('microsoft'), scope: MS_SCOPES.join(' '), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    err.code = json.error;
    throw err;
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token,
  };
}

async function microsoftAuthorize({ loginHint, interactive }) {
  const msClientId = await clientId('microsoft');
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${MS_BASE}/authorize`);
  url.search = new URLSearchParams({
    client_id: msClientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: REDIRECT_URI,
    scope: MS_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: interactive ? 'select_account' : 'none',
    ...(loginHint && { login_hint: loginHint }),
  });
  const params = await runAuthFlow(url, interactive);
  if (params.get('state') !== state) throw new Error('Microsoft sign-in returned a mismatched state');
  const code = params.get('code');
  if (!code) throw new Error('Microsoft did not return an authorization code');
  return msToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
}

const authorize = { gmail: googleAuthorize, outlook: microsoftAuthorize };

// Interactive sign-in for a new (or signed-out) account. Returns the token set;
// the caller identifies the mailbox with it and stores it via saveToken().
export async function signIn(provider, loginHint) {
  return authorize[provider]({ loginHint, interactive: true });
}

export async function saveToken(id, token) {
  const prev = await getAuth(id);
  // Keep an older refresh token if the new response did not include one.
  await setAuth(id, { ...token, refreshToken: token.refreshToken ?? prev?.refreshToken });
}

// Coalesce concurrent renewals for the same account within one context.
const inflight = new Map();

export function getAccessToken(account, { forceRenew = false } = {}) {
  const key = `${account.id}:${forceRenew}`;
  if (!inflight.has(key)) {
    inflight.set(key, renew(account, forceRenew).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function renew(account, forceRenew) {
  const cached = await getAuth(account.id);
  if (!forceRenew && cached?.accessToken && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
    return cached.accessToken;
  }
  if (account.provider === 'outlook' && cached?.refreshToken) {
    try {
      const token = await msToken({ grant_type: 'refresh_token', refresh_token: cached.refreshToken });
      await saveToken(account.id, token);
      return token.accessToken;
    } catch (e) {
      // invalid_grant = refresh token expired/revoked; fall through to silent re-auth.
      if (e.code !== 'invalid_grant' && e.code !== 'interaction_required') throw e;
    }
  }
  const token = await authorize[account.provider]({ loginHint: account.email, interactive: false });
  await saveToken(account.id, token);
  return token.accessToken;
}
