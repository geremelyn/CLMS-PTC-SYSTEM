// CP36 - Equipment "Save as PDF": US Letter document using the CP33 header and the CP34/CP35 footer approach.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';

// CP36.1 - Who may use Equipment "Save as PDF". Role keys are the backend authorization keys:
//   'MIS'             = Super Admin
//   'Inventory Staff' = shown in the UI as "MIS Staff" (README: Inventory Staff shown as "MIS Staff")
// Dean, Teacher, Others and unknown roles are not allowed. Independent of Export Excel's gate.
export const EQUIPMENT_PDF_ROLES = ['MIS', 'Inventory Staff'];
export function canSaveEquipmentPdf(role) {
  return EQUIPMENT_PDF_ROLES.includes(role);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same helper as the on-screen Equipment table.
export function prettyText(value) {
  return String(value || '').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function addedDateText(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'Asia/Manila' });
}

const CSS = `
.pdf-table .c-no{width:.3in;text-align:center}.pdf-table .c-stat{width:1in}.pdf-table .c-date{width:.95in}.pdf-table .c-by{width:.8in}
.pdf-table strong{font-weight:700}
.pdf-sub{display:block;margin-top:2px;font-size:7pt;color:#333}
.pdf-note{display:block;margin-top:2px;font-size:7pt;color:#333;font-style:italic}
`;

/**
 * @param {object[]} items  all equipment rows matching the current search (not just the visible page)
 * @param {object} ctx      { labName(id), computerName(id), computerDetails(id), search, logoBase, now }
 */
export function buildEquipmentPdfHtml(items, { labName = (id) => `Laboratory ${id || 'Unassigned'}`, computerName = () => 'Not assigned', computerDetails = () => null, search = '', logoBase = '', now = new Date() } = {}) {
  const stamp = generatedStamp(now);
  const rows = items.length
    ? items.map((item, i) => {
      const comp = item.computer_id ? computerDetails(item.computer_id) : null;
      const assignment = item.computer_id
        ? `<strong>${esc(computerName(item.computer_id))}</strong>${comp?.condition_note ? `<span class="pdf-note">Condition note: ${esc(comp.condition_note)}</span>` : ''}`
        : 'Not assigned';
      return `<tr><td class="c-no">${i + 1}</td>`
        + `<td><strong>${esc(prettyText(item.equipment_type))}</strong><span class="pdf-sub">${esc(item.brand || 'Unbranded')} ${esc(item.model || '')}</span></td>`
        + `<td>${esc(labName(item.laboratory_id ?? item.effective_laboratory_id))}</td>`
        + `<td>${assignment}</td>`
        + `<td><strong>${esc(item.asset_tag)}</strong><span class="pdf-sub">SN: ${esc(item.serial_number)}</span></td>`
        + `<td class="c-stat">${esc(prettyText(item.equipment_state || 'ACTIVE'))}</td>`
        + `<td class="c-stat">${esc(prettyText(item.status))}${item.condition_note ? `<span class="pdf-note">${esc(item.condition_note)}</span>` : ''}</td>`
        + `<td class="c-by">${esc(item.added_by_name || item.reported_by_name || '—')}</td>`
        + `<td class="c-date">${esc(addedDateText(item.report_date))}</td></tr>`;
    }).join('')
    : '<tr><td colspan="9" class="pdf-empty">No equipment matches the current search.</td></tr>';
  const body = `<h2 class="pdf-title">EQUIPMENT</h2>
<p class="pdf-meta">Total records: ${items.length}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th>Equipment Type</th><th>Laboratory</th><th>Computer Assignment</th><th>Asset Tag &amp; Serial Number</th><th class="c-stat">Status</th><th class="c-stat">Condition</th><th class="c-by">Added By</th><th class="c-date">Added Date</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS Equipment', bodyHtml: body, logoBase, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`)
}
