const test = require('node:test')
const assert = require('node:assert/strict')
const { workbookXml } = require('../utils/xlsxWriter.js')
const { parseXlsx } = require('../utils/xlsxParser.js')
const { parseWorkbookRows } = require('../utils/excelWorkbookRows.js')

test('generated Excel workbook round-trips through the XLSX parser with escaped text and headers', () => {
  const buffer = workbookXml('Computers', ['Computer Name', 'Laboratory ID', 'Asset Tag'], [['PC & Lab', '1', 'TAG<01>']])
  const sheets = parseXlsx(buffer)
  assert.deepEqual(sheets.Computers[0], ['Computer Name', 'Laboratory ID', 'Asset Tag'])
  assert.deepEqual(sheets.Computers[1], ['PC & Lab', '1', 'TAG<01>'])
})
test('generated workbook follows the Computers import header contract', () => {
  const headers = ['Computer Name','Laboratory ID','Asset Tag','Serial Number','Processor','RAM','Storage Capacity','Storage Unit','Storage Type','Operational Status','Condition','Condition Note']
  const row = ['PC-1','1','TAG-1','SN-1','Intel i5','8','256','GB','SSD','ACTIVE','WORKING','']
  const parsed = parseWorkbookRows(workbookXml('Computers', headers, [row]), 'computers', 'export.xlsx')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data.computer_name, 'PC-1')
  assert.equal(parsed[0].data.ram, 8)
  assert.equal(parsed[0].data.operational_status, 'ACTIVE')
})
