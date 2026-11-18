// CP35 - Computers "Save as PDF": US Letter document using the CP33 header and CP34 footer approach.
import { buildPdfDocumentHtml, pdfCommonCss } from './pdfHeader.js';
import { generatedStamp } from './laboratoriesPdf.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same wording as the on-screen Computers table.
export function computerLabName(c, laboratories = []) {
  return laboratories.find(lab => Number(lab.id) === Number(c.laboratory_id))?.laboratory_name || `Lab ${c.laboratory_id}`;
}
export const computerStorage = (c) => `${c.storage_capacity} ${c.storage_unit} ${c.storage_type}`;

const CSS = `
.pdf-table .c-no{width:.3in;text-align:center}.pdf-table .c-ram{width:.45in}.pdf-table .c-stat{width:.6in}.pdf-table .c-cond{width:.95in}
.pdf-table .c-sto{width:.8in}.pdf-table .c-tag{width:.75in}
.pdf-note{display:block;margin-top:2px;font-size:7pt;color:#333;font-style:italic}
`;

export function buildComputersPdfHtml(computers, { laboratories = [], search = '', logoBase = '', now = new Date() } = {}) {
  const stamp = generatedStamp(now);
  const rows = computers.length
    ? computers.map((c, i) => `<tr><td class="c-no">${i + 1}</td><td>${esc(c.computer_name)}</td><td>${esc(computerLabName(c, laboratories))}</td><td class="c-tag">${esc(c.asset_tag)}</td><td>${esc(c.serial_number)}</td><td>${esc(c.processor)}</td><td class="c-ram">${esc(c.ram)} GB</td><td class="c-sto">${esc(computerStorage(c))}</td><td class="c-stat">${esc(c.operational_status)}</td><td class="c-cond">${esc(c.condition)}${c.condition_note ? `<span class="pdf-note">${esc(c.condition_note)}</span>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="10" class="pdf-empty">No computers match the current search.</td></tr>';
  const body = `<h2 class="pdf-title">COMPUTERS</h2>
<p class="pdf-meta">Total records: ${computers.length}${search ? ` &nbsp;|&nbsp; Search filter: “${esc(search)}”` : ''} &nbsp;|&nbsp; Generated: ${esc(stamp)}</p>
<table class="pdf-table"><thead><tr><th class="c-no">No.</th><th>Computer Name</th><th>Laboratory</th><th class="c-tag">Asset Tag</th><th>Serial No.</th><th>Processor</th><th class="c-ram">RAM</th><th class="c-sto">Storage</th><th class="c-stat">Status</th><th class="c-cond">Condition</th></tr></thead><tbody>${rows}</tbody></table>`;
  const html = buildPdfDocumentHtml({ title: 'CLMS Computers', bodyHtml: body, logoBase, signature: true });
  return html.replace('</style>', `${pdfCommonCss(stamp)}${CSS}</style>`)
}
