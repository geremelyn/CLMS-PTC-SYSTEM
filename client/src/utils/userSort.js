// CP107: User Accounts are listed A-Z by the name the table DISPLAYS: Surname, then First name, then M.I.
// (the stored full_name is "First M. Surname", so the database order is by first name and cannot be used for this).
// Case-insensitive, accent-tolerant, numeric-aware; accounts with no usable name go last; username is the final tie-breaker
// so the order is identical on every load, search, refresh and page change.
import { nameParts } from './usersPdf.js';

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function userSortKey(u) {
  if (u.role === 'MIS') return { surname: 'Super Admin', first: '', mi: '' }; // the table shows "Super Admin" in the Surname column
  const { surname, first, mi } = nameParts(u);
  return { surname: String(surname || '').trim(), first: String(first || '').trim(), mi: String(mi || '').trim() };
}

export function compareUsersByName(a, b) {
  const x = userSortKey(a), y = userSortKey(b);
  const xBlank = !x.surname && !x.first, yBlank = !y.surname && !y.first;
  if (xBlank !== yBlank) return xBlank ? 1 : -1;
  return collator.compare(x.surname, y.surname) || collator.compare(x.first, y.first) || collator.compare(x.mi, y.mi)
    || collator.compare(String(a.username || ''), String(b.username || '')) || (Number(a.id) || 0) - (Number(b.id) || 0);
}

export function sortUsersByName(users) {
  return [...(Array.isArray(users) ? users : [])].sort(compareUsersByName);
}
