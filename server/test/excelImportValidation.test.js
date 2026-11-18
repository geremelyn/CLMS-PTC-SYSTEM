const test = require('node:test')
const assert = require('node:assert/strict')
const { mapRow, validateRows } = require('../utils/excelImportValidation.js')
const { runInTransaction } = require('../utils/transactionalImport.js')

const reference = {
  laboratories: [{ id: 1 }, { id: 2 }],
  computers: [{ id: 10, computer_name: 'PC-LAB1-01', laboratory_id: 1 }, { id: 11, computer_name: 'PC-LAB2-01', laboratory_id: 2 }],
  existingTags: ['EXISTING-TAG'], existingSerials: ['EXISTING-SERIAL'],
  options: { computer_storage_unit: ['GB', 'TB'], computer_storage_type: ['HDD', 'SSD'], computer_status: ['ACTIVE', 'INACTIVE'], computer_condition: ['WORKING', 'DAMAGED', 'UNDER REPAIR'], equipment_status: ['WORKING', 'DAMAGED', 'UNDER REPAIR'] }
}
const validComputer = { computer_name: 'PC-1', laboratory_id: 1, asset_tag: 'TAG-1', serial_number: 'SN-1', processor: 'Intel i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING', condition_note: '' }
const validEquipment = { equipment_type: 'Projector', laboratory_id: 1, computer_id: 10, asset_tag: 'EQ-1', serial_number: 'EQ-SN-1', status: 'WORKING' }

test('maps sample workbook column headings and RAM values', () => {
  const row = mapRow(['Computer Name', 'Laboratory ID', 'Asset Tag', 'RAM', 'Storage Unit'], ['PC-1', 1, 'TAG-1', '8 GB', 'GB'], 'computers')
  assert.equal(row.computer_name, 'PC-1')
  assert.equal(row.laboratory_id, 1)
  assert.equal(row.ram, 8)
})
test('accepts valid computer and equipment rows', () => {
  assert.equal(validateRows([{ rowNumber: 2, data: validComputer }], 'computers', reference)[0].valid, true)
  assert.equal(validateRows([{ rowNumber: 2, data: validEquipment }], 'equipment', reference)[0].valid, true)
})
test('reports missing required fields and malformed numeric fields by row', () => {
  const result = validateRows([{ rowNumber: 7, data: { ...validComputer, computer_name: '', ram: '8.5', storage_capacity: 0, laboratory_id: 99 } }], 'computers', reference)[0]
  assert.equal(result.rowNumber, 7)
  assert.ok(result.errors.some(error => /computer name is required/i.test(error)))
  assert.ok(result.errors.some(error => /ram must be a positive whole number/i.test(error)))
  assert.ok(result.errors.some(error => /storage capacity must be a positive whole number/i.test(error)))
  assert.ok(result.errors.some(error => /laboratory id 99 does not exist/i.test(error)))
})
test('rejects duplicate asset tags and serial numbers in-file and against existing records', () => {
  const rows = validateRows([
    { rowNumber: 2, data: { ...validComputer, asset_tag: 'EXISTING-TAG', serial_number: 'SN-A' } },
    { rowNumber: 3, data: { ...validComputer, asset_tag: 'tag-1', serial_number: 'SN-A' } },
    { rowNumber: 4, data: { ...validComputer, asset_tag: 'TAG-3', serial_number: 'EXISTING-SERIAL' } }
  ], 'computers', reference)
  assert.ok(rows[0].errors.some(error => /already exists in the database/i.test(error)))
  assert.ok(rows[1].errors.some(error => /duplicates row 2/i.test(error)))
  assert.ok(rows[2].errors.some(error => /already exists in the database/i.test(error)))
})
test('allows lab-level equipment without a computer assignment and validates assignments when supplied', () => {
  const unassigned = validateRows([{ rowNumber: 2, data: { ...validEquipment, computer_id: '' } }], 'equipment', reference)[0]
  assert.equal(unassigned.valid, true)
  assert.equal(unassigned.data.computer_id, null)
  const byName = validateRows([{ rowNumber: 2, data: { ...validEquipment, computer_id: 'PC-LAB1-01' } }], 'equipment', reference)[0]
  assert.equal(byName.valid, true)
  assert.equal(byName.data.computer_id, 10)
  const mismatch = validateRows([{ rowNumber: 3, data: { ...validEquipment, computer_id: 11 } }], 'equipment', reference)[0]
  assert.ok(mismatch.errors.some(error => /must belong to the selected laboratory/i.test(error)))
})
test('transaction commits successful imports and rolls back a failed insert without commit', async () => {
  const calls = []
  const connection = Object.fromEntries(['beginTransaction','commit','rollback'].map(method => [method, callback => { calls.push(method); callback(null) }]))
  await runInTransaction(connection, async () => { calls.push('insert-1'); calls.push('insert-2'); return true })
  assert.deepEqual(calls, ['beginTransaction','insert-1','insert-2','commit'])
  calls.length = 0
  await assert.rejects(runInTransaction(connection, async () => { calls.push('insert-1'); throw new Error('simulated insert failure') }), /simulated insert failure/)
  assert.deepEqual(calls, ['beginTransaction','insert-1','rollback'])
})

test('parses the actual .xlsx sample workbook and exposes both import sheets', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { parseXlsx } = require('../utils/xlsxParser.js')
  const { parseWorkbookRows } = require('../utils/excelWorkbookRows.js')
  const workbookPath = path.join(__dirname, '../../templates/CLMS_Sample_Excel_Template.xlsx')
  const sheets = parseXlsx(fs.readFileSync(workbookPath))
  assert.ok(sheets['Computers Template'])
  assert.ok(sheets['Equipment Template'])
  const computerRow = mapRow(sheets['Computers Template'][0], sheets['Computers Template'][1], 'computers')
  assert.equal(computerRow.computer_name, 'PC-LAB1-01')
  assert.equal(computerRow.ram, 8)
  const equipmentRow = mapRow(sheets['Equipment Template'][0], sheets['Equipment Template'][1], 'equipment')
  assert.equal(equipmentRow.computer_id, 'PC-LAB1-01')
  const importedRows = parseWorkbookRows(fs.readFileSync(workbookPath), 'equipment', 'sample.xlsx')
  assert.equal(importedRows[0].rowNumber, 2)
  assert.equal(importedRows[0].data.computer_id, 'PC-LAB1-01')
  const computerRows = parseWorkbookRows(fs.readFileSync(workbookPath), 'computers', 'sample.xlsx')
  assert.equal(validateRows(computerRows, 'computers', reference)[0].valid, true)
  assert.equal(validateRows(importedRows, 'equipment', reference)[0].valid, true)
})
test('rejects malformed or non-ZIP workbook bytes', () => {
  const { parseXlsx } = require('../utils/xlsxParser.js')
  assert.throws(() => parseXlsx(Buffer.from('not an excel workbook')), /valid .xlsx ZIP workbook/i)
})

test('reports missing equipment fields and duplicate identifiers before commit', () => {
  const row = validateRows([{ rowNumber: 9, data: { ...validEquipment, equipment_type: '', computer_id: '', asset_tag: 'EXISTING-TAG', serial_number: '' } }], 'equipment', reference)[0]
  assert.ok(row.errors.some(error => /equipment type is required/i.test(error)))
  assert.equal(row.errors.some(error => /computer assignment is required/i.test(error)), false)
  assert.ok(row.errors.some(error => /serial number is required/i.test(error)))
  assert.ok(row.errors.some(error => /already exists in the database/i.test(error)))
})
