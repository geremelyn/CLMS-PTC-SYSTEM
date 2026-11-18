'use strict'
const { parseXlsx } = require('./xlsxParser.js')
const { mapRow } = require('./excelImportValidation.js')
const { missingColumnsMessage } = require('./importDiagnostics.js')
const MAX_ROWS = 2000
function parseWorkbookRows(buffer, type, fileName = 'upload.xlsx') {
  if (!/\.xlsx$/i.test(String(fileName))) throw new Error('Choose a valid .xlsx workbook no larger than 5 MB.')
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('Choose a valid .xlsx workbook no larger than 5 MB.')
  const sheets = parseXlsx(buffer)
  const preferred = type === 'computers' ? ['Computers Template', 'Computers'] : ['Equipment Template', 'Equipment']
  const sheetName = preferred.find(name => sheets[name]) || Object.keys(sheets)[0]
  if (!sheetName) throw new Error('The workbook does not contain a readable worksheet.')
  const matrix = sheets[sheetName]
  const headerIndex = matrix.findIndex(row => row.some(value => String(value ?? '').trim() !== ''))
  if (headerIndex < 0 || matrix.slice(headerIndex + 1).every(row => !row?.some(value => String(value ?? '').trim() !== ''))) throw new Error('The selected worksheet must contain a header row and at least one data row.')
  const headers = matrix[headerIndex]
  const columnProblem = missingColumnsMessage(sheetName, headers, type); if (columnProblem) throw new Error(columnProblem)
  const rows = matrix.slice(headerIndex + 1).map((values, index) => ({ rowNumber: headerIndex + index + 2, data: mapRow(headers, values || [], type) })).filter(row => Object.values(row.data).some(value => String(value ?? '').trim() !== ''))
  if (rows.length > MAX_ROWS) throw new Error(`The import is limited to ${MAX_ROWS} rows per file.`)
  return rows
}
module.exports = { parseWorkbookRows, MAX_ROWS }
