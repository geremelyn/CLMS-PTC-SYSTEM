// CP37 - User Accounts "Save as PDF": US Letter document using the CP33 header and CP34-CP36 footer approach.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';

// Super Admin only. 'MIS' is the backend authorization key for Super Admin (README). Independent of Export Excel.
export function canSaveUsersPdf(role) {
  return role === 'MIS';
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same helper as the on-screen User Accounts table (Users.jsx).
export function nameParts(u) {
  if (u.surname || u.first_name) return { surname: u.surname || '', first: u.first_name || '', mi: u.middle_initial || '' };
  const tokens = String(u.full_name || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { surname: tokens[0] || '', first: '', mi: '' };
  return { surname: tokens[tokens.length - 1], first: tokens.slice(0, -1).join(' '), mi: '' };
}
// CP166: the MIS Head / Super Admin row shows the account's OWN stored name (the designated MIS Head's full name), like every other account.
// Only a missing or generic placeholder name ("Super Admin", "MIS", "Admin"...) falls back to the previous "Super Admin" display.
// No person's name is hardcoded here, so no other account can be affected.
const GENERIC_ACCOUNT_NAMES = ['', 'super admin', 'mis', 'mis head', 'admin', 'administrator'];
export function userNameParts(u) {
  if (u.role !== 'MIS') return nameParts(u);
  const hasRealName = Boolean(u.surname || u.first_name) || !GENERIC_ACCOUNT_NAMES.includes(String(u.full_name || '').trim().replace(/\s+/g, ' ').toLowerCase());
  return hasRealName ? nameParts(u) : { surname: 'Super Admin', first: '', mi: '' };
}
// Same role wording as the on-screen table.
export function userRoleLabel(u) {
  return u.role === 'MIS' ? 'Super Admin' : u.role_other ? u.role_other : u.role === 'Teacher' && u.program ? `${u.program}-Teacher` : u.role === 'Inventory Staff' ? 'MIS Staff' : u.role;
}

const CSS = `
.pdf-table .c-no{width:.35in;text-align:center}.pdf-table .c-id{width:1in}.pdf-table .c-mi{width:.4in;text-align:center}.pdf-table .c-stat{width:.75in}
`;

/** @param {object[]} users all user rows matching the current search (not just the visible page). Passwords are never read. */
export function buildUsersPdfHtml(users, { search = '', logoBase = '', now = new Date() } = {}) {
  const stamp = generatedStamp(now);
  const rows = users.length
    ? users.map((u, i) => {
      const n = userNameParts(u);
      return `<tr><td class="c-no">${i + 1}</td><td class="c-id">${esc(u.username)}</td>`
        + `<td>${esc(n.surname)}</td>`
        + `<td>${esc(n.first || '—')}</td>`
        + `<td class="c-mi">${esc(n.mi || '—')}</td>`
        + `<td>${esc(u.program || '—')}</td>`
        + `<td>${esc(userRoleLabel(u))}</td>`
        + `<td class="c-stat">${esc(u.status || 'ACTIVE')}</td></tr>`;
    }).join('')
    : '<tr><td colspan="8" class="pdf-empty">No users match your search.</td></tr>';
  const body = `<h2 class="pdf-title">USER ACCOUNTS</h2>
<p class="pdf-meta">Total records: ${users.length}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th class="c-id">ID Number</th><th>Surname</th><th>First Name</th><th class="c-mi">MI</th><th>Program</th><th>Role</th><th class="c-stat">Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS User Accounts', bodyHtml: body, logoBase, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`)
}
