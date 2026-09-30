// Optional fallback OAuth client IDs. Normally you enter them in the app under
// Settings → OAuth client IDs, which survives updates; see docs/SETUP.md.
// Neither value is a secret: both flows are public-client flows (no client secret).
export const GOOGLE_CLIENT_ID = 'PASTE_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
export const MICROSOFT_CLIENT_ID = 'PASTE_MICROSOFT_APPLICATION_ID';

export const DEFAULT_SETTINGS = {
  pollMinutes: 2,
  markReadOnOpen: true,
  loadRemoteImages: false,
  showHidden: false,
  notifyEnabled: true,
  soundEnabled: true,
  // How macOS shows Chrome's notifications (System Settings → Notifications →
  // Google Chrome); 'temporary' is the macOS default.
  bannerStyle: 'temporary',
  undoSendSeconds: 10,
  senderName: '',
  // Offline cache of bodies and attachments (MB; 0 = no limit).
  cacheLimitMB: 1024,
  catboxUserhash: '',
  x02ApiKey: '',
};

// How many unread messages to keep per account in the sidebar.
export const MAX_MESSAGES_PER_ACCOUNT = 30;
