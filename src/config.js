// OAuth client IDs. See docs/SETUP.md for how to create them.
// Neither value is a secret: both flows are public-client flows (no client secret).
export const GOOGLE_CLIENT_ID = 'PASTE_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
export const MICROSOFT_CLIENT_ID = 'PASTE_MICROSOFT_APPLICATION_ID';

export const DEFAULT_SETTINGS = {
  pollMinutes: 2,
  markReadOnOpen: true,
  loadRemoteImages: false,
  showHidden: false,
};

// How many unread messages to keep per account in the sidebar.
export const MAX_MESSAGES_PER_ACCOUNT = 30;
