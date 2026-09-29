import { gmail } from './gmail.js';
import { aol, icloud, yahoo } from './imap.js';
import { outlook } from './outlook.js';
import { proton } from './proton.js';

// Display order in the rail. Gmail and Outlook use their official APIs;
// iCloud, Yahoo and AOL use IMAP through the local helper; Proton uses the
// signed-in mail.proton.me session.
export const providers = { gmail, outlook, icloud, yahoo, aol, proton };
