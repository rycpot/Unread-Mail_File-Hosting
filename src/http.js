import { AuthRequiredError, getAccessToken } from './auth.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Authorised fetch for an account. On 401 it renews the token once and retries;
// a second 401 means the account needs an interactive sign-in.
// rawBody (string/Blob) is sent as is, with its Content-Type in headers.
export async function apiFetch(account, url, { method = 'GET', body, rawBody, headers = {}, raw = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(account, { forceRenew: attempt > 0 });
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    if (res.status === 401) {
      if (attempt === 0) continue;
      throw new AuthRequiredError('Access was revoked or expired');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const json = await res.json();
        detail = json.error?.message ?? json.error_description ?? '';
      } catch {}
      throw new ApiError(detail || `Request failed (${res.status})`, res.status);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }
}
