import { gmail } from './gmail.js';
import { aol, icloud, yahoo } from './imap.js';
import { outlook } from './outlook.js';

// Display order in the sidebar. Gmail and Outlook use their official APIs;
// iCloud, Yahoo and AOL use IMAP through the local helper. Proton (session
// based) is still to come.
export const providers = { gmail, outlook, icloud, yahoo, aol };
