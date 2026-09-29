import { gmail } from './gmail.js';
import { outlook } from './outlook.js';

// Display order in the sidebar. Session-based providers (iCloud, Yahoo, AOL,
// Proton) will be added here in the next phase.
export const providers = { gmail, outlook };
