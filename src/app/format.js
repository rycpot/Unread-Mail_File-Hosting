// The one date/time format used everywhere in the app:
//   date      30 Sep 2026
//   time      5:06PM
//   both      30 Sep 2026 5:06PM

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const valid = (d) => d instanceof Date && !isNaN(d);
const toDate = (v) => (v instanceof Date ? v : new Date(v));

export function fmtDate(v) {
  const d = toDate(v);
  return valid(d) ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

export function fmtTime(v) {
  const d = toDate(v);
  if (!valid(d)) return '';
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

export function fmtDateTime(v) {
  const d = toDate(v);
  return valid(d) ? `${fmtDate(d)} ${fmtTime(d)}` : '';
}
