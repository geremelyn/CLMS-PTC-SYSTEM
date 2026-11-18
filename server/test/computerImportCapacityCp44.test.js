'use strict'
// CP44: pure-validation tests (no database). Real MySQL/MariaDB is unavailable in this environment.
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateRows } = require('../utils/excelImportValidation.js')
const row = (n, lab) => ({ rowNumber: n, data: { computer_name: `PC${n}`, laboratory_id: lab, asset_tag: `AT${n}`, serial_number: `SN${n}`, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' } })
test('computer import respects laboratory capacity (existing + in-file rows)', () => {
  const ref = { laboratories: [{ id: 1, capacity: 2 }], computers: [{ id: 9, laboratory_id: 1 }] }
  const out = validateRows([row(2, 1), row(3, 1)], 'computers', ref)
  assert.equal(out[0].valid, true); assert.equal(out[1].valid, false); assert.match(out[1].errors.join(), /reached its limit/)
})
test('capacity check is skipped when capacity is unknown, and other labs are unaffected', () => {
  assert.ok(validateRows([row(2, 1), row(3, 1)], 'computers', { laboratories: [{ id: 1 }] }).every(r => r.valid))
  assert.ok(validateRows([row(2, 1), row(3, 2)], 'computers', { laboratories: [{ id: 1, capacity: 1 }, { id: 2, capacity: 1 }] }).every(r => r.valid))
})
