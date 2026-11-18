'use strict'
// Minimal multi-sheet .xlsx writer used only for the downloadable import templates (the single-sheet exporter in xlsxWriter.js is unchanged).
// Cells are inline strings (same as the exporter) so the project's own xlsxParser reads them back. Row 1 style: bold header.
const { zipFiles, xmlEscape } = require('./xlsxWriter.js')
function columnName(index) { let n = index + 1, result = ''; while (n) { const rem = (n - 1) % 26; result = String.fromCharCode(65 + rem) + result; n = Math.floor((n - 1) / 26) } return result }
const safeName = name => String(name || 'Sheet').slice(0, 31).replace(/[\\/?*[\]:]/g, '_') || 'Sheet'
// sheet = { name, rows: [[...]], widths?: [numbers], boldRows?: [1-based row numbers], wrap?: true }
function sheetXml(sheet) {
  const widths = sheet.widths && sheet.widths.length ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''
  const bold = new Set(sheet.boldRows || [])
  const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"${bold.has(r + 1) ? ' s="1"' : (sheet.wrap ? ' s="2"' : '')}><is><t xml:space="preserve">${xmlEscape(value ?? '')}</t></is></c>`).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${widths}<sheetData>${rows}</sheetData></worksheet>`
}
function buildWorkbook(sheets) {
  const NS = 'http://schemas.openxmlformats.org/'
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(safeName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>`
  }
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s) })
  return zipFiles(files)
}
module.exports = { buildWorkbook }
