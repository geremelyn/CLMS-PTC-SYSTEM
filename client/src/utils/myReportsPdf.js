// CP85 - "My Reports" Save as PDF for custom-role (Others) users: the official PTC header (pdfHeader.js: PTC logo, school name, address,
// IICT line) + their OWN issue reports only. The rows passed in are the rows the server already restricted to this user.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';
import { formatReportValue } from './reportFormatting.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function canSaveMyReportsPdf(role) { return role === 'Others'; }

// Presentation of one maintenance report row (same fields the on-screen table shows, readable wording).
export function myReportRow(row) {
  return {
    submitted: formatReportValue(row.date_reported),
    item: row.computer_name ? `Computer: ${row.computer_name}` : row.equipment_type ? `Equipment: ${row.equipment_type}` : '—',
    laboratory: row.laboratory_name || '—',
    issue: row.issue_description || '—',
    status: row.status || '—',
    resolved: formatReportValue(row.date_resolved),
    note: row.maintenance_note || '—',
  };
}

const CSS = `.pdf-table .c-no{width:.3in;text-align:center}.pdf-table .c-date{width:1in}.pdf-table .c-stat{width:.8in}.pdf-table td{vertical-align:top;overflow-wrap:anywhere}`;

export function buildMyReportsPdfHtml(rows, { owner = '', logoBase = '', now = new Date() } = {}) {
  const stamp = generatedStamp(now);
  const body = `<h2 class="pdf-title">MY REPORTS</h2>
<p class="pdf-meta">${owner ? `Submitted by: ${esc(owner)} &nbsp;|&nbsp; ` : ''}Total reports: ${rows.length} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th class="c-date">Date Submitted</th><th>Item</th><th>Laboratory</th><th>Issue</th><th class="c-stat">Status</th><th class="c-date">Date Resolved</th><th>Maintenance Note</th></tr></thead><tbody>${
    rows.length ? rows.map((r, i) => { const v = myReportRow(r); return `<tr><td class="c-no">${i + 1}</td><td class="c-date">${esc(v.submitted)}</td><td>${esc(v.item)}</td><td>${esc(v.laboratory)}</td><td>${esc(v.issue)}</td><td class="c-stat">${esc(v.status)}</td><td class="c-date">${esc(v.resolved)}</td><td>${esc(v.note)}</td></tr>`; }).join('')
      : '<tr><td colspan="8" class="pdf-empty">You have not submitted any reports.</td></tr>'}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS My Reports', bodyHtml: body, logoBase, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`);
}
