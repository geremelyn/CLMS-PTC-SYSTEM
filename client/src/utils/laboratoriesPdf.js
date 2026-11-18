// CP34 - Laboratories "Save as PDF": builds a US Letter document using the CP33 PDF header.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';

// CP38 - Laboratories "Save as PDF" is Super Admin only. 'MIS' is the backend authorization key for Super Admin.
// (MIS Staff = 'Inventory Staff' key does NOT get the Laboratories PDF.) Independent of Export Excel.
export function canSaveLaboratoriesPdf(role) {
  return role === 'MIS';
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dateOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function labStatusLabel(lab) {
  if (lab.status_other) return lab.status_other;
  const text = String(lab.status || '').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// Same wording as the on-screen "Reason" column.
export function labDetails(lab) {
  if (lab.status_other) return lab.reason || '—';
  if (lab.status === 'UNAVAILABLE') return `Unavailable from ${dateOnly(lab.unavailable_from) || '—'} until ${dateOnly(lab.unavailable_until) || '—'}${lab.reason ? ` — ${lab.reason}` : ''}`;
  if (lab.status === 'USED') return `Used from ${dateOnly(lab.used_from) || '—'} until ${dateOnly(lab.used_until) || '—'}`;
  return `Available from ${dateOnly(lab.available_date_from) || '—'} until ${dateOnly(lab.available_date_until) || '—'}`;
}

export function generatedStamp(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(now) + ' (Manila time)';
}

const LAB_PDF_CSS = `
.pdf-table .c-no{width:.4in;text-align:center}.pdf-table .c-cap{width:.7in;text-align:center}.pdf-table .c-stat{width:1in}
`;

export function buildLaboratoriesPdfHtml(labs, { search = '', logoBase = '', now = new Date() } = {}) {
  const stamp = generatedStamp(now);
  const rows = labs.length
    ? labs.map((lab, i) => `<tr><td class="c-no">${i + 1}</td><td>${esc(lab.laboratory_name)}</td><td class="c-cap">${esc(lab.capacity)}</td><td class="c-stat">${esc(labStatusLabel(lab))}</td><td>${esc(labDetails(lab))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="pdf-empty">No laboratories match the current search.</td></tr>';
  const body = `<h2 class="pdf-title">LABORATORIES</h2>
<p class="pdf-meta">Total records: ${labs.length}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th>Laboratory</th><th class="c-cap">Capacity</th><th class="c-stat">Status</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS Laboratories', bodyHtml: body, logoBase, signature: true });
  // Footer: generated date (left) and "Page X of Y" (right) via @page margin boxes.
  return html.replace('</style>', `${pdfCommonCss(stamp)}${LAB_PDF_CSS}</style>`)
}
