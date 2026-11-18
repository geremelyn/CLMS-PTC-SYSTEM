// CP101 - Maintenance History "Print PDF": same shared PTC-branded US Letter template as the other module PDFs
// (CP33 header with PTC + ICCT logos, school name / address / institute, CP39 table + footer, CP97 "Printed by" line).
// It prints exactly the columns and rows of the on-screen history table: every record that matches the current search
// (not just the visible page), with the same asset / reporter / issue / status / date wording.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same wording helpers as the on-screen table (Maintenance.jsx).
export function formatMaintenanceStatus(status) {
  return String(status || '').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function formatMaintenanceDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

const CSS = `
.pdf-table .c-no{width:.35in;text-align:center}.pdf-table .c-asset{width:1.15in}.pdf-table .c-by{width:1.55in}.pdf-table .c-stat{width:1in}.pdf-table .c-date{width:1.35in}
.pdf-table small{display:block;font-size:7pt;color:#333}.pdf-table td strong{font-weight:700}
`;

/**
 * @param {object[]} records maintenance history rows matching the current search (all pages)
 * @param {{getAsset:(record:object)=>{tag:string,type:string,name:string}, search?:string, logoBase?:string, now?:Date, printedBy?:object}} options
 */
export function buildMaintenanceHistoryPdfHtml(records, { getAsset, search = '', logoBase = '', now = new Date(), printedBy } = {}) {
  const stamp = generatedStamp(now);
  const rows = records.length
    ? records.map((record, i) => {
      const asset = getAsset(record);
      const role = record.reported_by_role === 'Inventory Staff' ? 'MIS Staff' : record.reported_by_role || '—';
      const status = record.status_other ? record.status_other : formatMaintenanceStatus(record.status);
      return `<tr><td class="c-no">${i + 1}</td>`
        + `<td><strong>${esc(asset.tag)}</strong><small>${esc(asset.type)}${asset.name ? ` - ${esc(asset.name)}` : ''}</small></td>`
        + `<td><strong>${esc(record.reported_by_name || 'Unknown user')}</strong><small>ID Number: ${esc(record.reported_by_username || '—')}</small><small>${esc(record.reported_by_program || '—')} · ${esc(role)}</small></td>`
        + `<td>${esc(record.issue_description || 'No issue description')}</td>`
        + `<td><strong>${esc(status)}</strong>${record.maintenance_note ? `<small>${esc(record.maintenance_note)}</small>` : ''}</td>`
        + `<td><strong>Reported</strong><small>${esc(formatMaintenanceDate(record.date_reported))}</small><strong>Resolved</strong><small>${esc(formatMaintenanceDate(record.date_resolved))}</small></td></tr>`;
    }).join('')
    : '<tr><td colspan="6" class="pdf-empty">No maintenance history records match your search.</td></tr>';
  const body = `<h2 class="pdf-title">MAINTENANCE HISTORY</h2>
<p class="pdf-meta">Total records: ${records.length}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th class="c-asset">Asset</th><th class="c-by">Reported By (ID Number, Name, Program, Role)</th><th>Issue</th><th class="c-stat">Status</th><th class="c-date">Reported / Resolved Date &amp; Time</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS Maintenance History', bodyHtml: body, logoBase, printedBy, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`);
}
