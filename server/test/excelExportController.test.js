const test = require('node:test')
const assert = require('node:assert/strict')
const { createExcelExportController } = require('../controllers/excelExportController.js')
const { parseXlsx } = require('../utils/xlsxParser.js')
function mockResponse() {
  return { headers: {}, statusCode: 200, body: null, setHeader(key, value) { this.headers[key] = value; return this }, status(code) { this.statusCode = code; return this }, send(body) { this.body = body; return this }, json(body) { this.body = body; return this } }
}
test('Computer export endpoint returns an XLSX workbook with the expected import-compatible headers and filtered data', () => {
  const response = mockResponse()
  createExcelExportController('computers')({ body: { rows: [{ computer_name: 'PC-1', laboratory_id: 1, asset_tag: 'TAG-1', serial_number: 'SN-1', ram: 8, operational_status: 'ACTIVE', condition: 'WORKING' }] } }, response)
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['Content-Type'], /spreadsheetml\.sheet/)
  assert.match(response.headers['Content-Disposition'], /CLMS_Computers_Export\.xlsx/)
  const sheets = parseXlsx(response.body)
  assert.equal(sheets.Computers[0][0], 'Computer Name')
  assert.equal(sheets.Computers[1][0], 'PC-1')
  assert.equal(sheets.Computers[1][2], 'TAG-1')
})
test('Equipment export endpoint maps computer assignment, Added By and Added Date', () => {
  const response = mockResponse()
  createExcelExportController('equipment')({ body: { rows: [{ equipment_type: 'Projector', laboratory_id: 2, computer_id: 9, asset_tag: 'EQ-1', serial_number: 'EQ-SN-1', status: 'WORKING', reported_by_username: '2026002', report_date: '2026-10-27 09:30:00' }] } }, response)
  const sheets = parseXlsx(response.body)
  assert.equal(sheets.Equipment[0][2], 'Computer Assignment (ID or exact computer name)')
  assert.equal(sheets.Equipment[1][2], '9')
  assert.equal(sheets.Equipment[1][8], '2026002') // CP171: Status and Condition are now separate columns (index 5 and 6), so Added By / Added Date moved by one
  assert.equal(sheets.Equipment[1][9], '2026-10-27 09:30:00')
})
test('Export endpoint rejects missing and oversized row collections', () => {
  const handler = createExcelExportController('computers')
  const missing = mockResponse(); handler({ body: {} }, missing)
  assert.equal(missing.statusCode, 400)
  const oversized = mockResponse(); handler({ body: { rows: Array.from({ length: 10001 }, () => ({})) } }, oversized)
  assert.equal(oversized.statusCode, 400)
})
