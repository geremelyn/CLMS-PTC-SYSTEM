// CP102 - Audit Log "Print / Save PDF": same shared PTC-branded US Letter template as the other module PDFs
// (CP33 header with PTC + ICCT logos, school name / address / institute, CP39 table + footer, CP97 "Printed by" line).
// Prints exactly the on-screen columns (Action, Description, Date & Time, Recorded By, ID Number, Role) for EVERY audit
// entry that matches the current search (all pages), with the same wording as the screen. Super Admin access is enforced by the page.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function formatAuditDate(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

const CSS = `
.pdf-table .c-no{width:.35in;text-align:center}.pdf-table .c-act{width:1.15in}.pdf-table .c-date{width:1.32in}.pdf-table .c-by{width:1.05in}.pdf-table .c-id{width:.8in}.pdf-table .c-role{width:.8in}
`;

/**
 * @param {object[]} logs audit rows matching the current search (all pages)
 * @param {{roleLabel:(log:object)=>string, search?:string, eventType?:string (CP109: shown in the meta line only when a specific event type is selected), logoBase?:string, now?:Date, printedBy?:object}} options
 */
export function buildAuditLogPdfHtml(logs, { roleLabel, search = '', eventType = '', logoBase = '', now = new Date(), printedBy } = {}) {
  const stamp = generatedStamp(now);
  const rows = logs.length
    ? logs.map((log, i) => `<tr><td class="c-no">${i + 1}</td><td class="c-act">${esc(log.action || '—')}</td><td>${esc(log.description || '—')}</td>`
      + `<td class="c-date">${esc(formatAuditDate(log.created_at))}</td><td class="c-by">${esc(log.full_name || 'System')}</td><td class="c-id">${esc(log.username || '—')}</td><td class="c-role">${esc(roleLabel(log))}</td></tr>`).join('')
    : '<tr><td colspan="7" class="pdf-empty">No audit activities match your search.</td></tr>';
  const body = `<h2 class="pdf-title">AUDIT LOG</h2>
<p class="pdf-meta">Total records: ${logs.length}${eventType ? ` &nbsp;|&nbsp; Event type: “${esc(eventType)}”` : ''}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th class="c-act">Action</th><th>Description</th><th class="c-date">Date &amp; Time</th><th class="c-by">Recorded By</th><th class="c-id">ID Number</th><th class="c-role">Role</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS Audit Log', bodyHtml: body, logoBase, printedBy, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`);
}
