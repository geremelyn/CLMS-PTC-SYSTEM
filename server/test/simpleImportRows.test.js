const test = require('node:test')
const assert = require('node:assert/strict')
const { mapRow, validateSimpleRows } = require('../utils/simpleImportRows.js')

test('laboratory import: known and custom statuses, duplicates, bad capacity', () => {
  const headers = ['Laboratory Name', 'Capacity', 'Status', 'Reason']
  const rows = [['Laboratory 5', '30', 'Open', ''], ['Laboratory 6', '25', 'Under renovation', ''], ['Laboratory 1', '20', 'Open', ''], ['Laboratory 7', 'x', 'Open', ''], ['Laboratory 5', '10', 'Open', '']]
    .map((values, i) => ({ rowNumber: i + 2, data: mapRow(headers, values, 'laboratories') }))
  const result = validateSimpleRows(rows, 'laboratories', { existing: ['Laboratory 1'] })
  assert.equal(result[0].valid, true); assert.equal(result[0].data.status, 'OPEN'); assert.equal(result[0].data.status_other, null)
  assert.equal(result[1].valid, true); assert.equal(result[1].data.status, 'UNAVAILABLE'); assert.equal(result[1].data.status_other, 'Under renovation')
  assert.equal(result[2].valid, false); assert.match(result[2].errors.join(' '), /already exists/)
  assert.equal(result[3].valid, false)
  assert.equal(result[4].valid, false); assert.match(result[4].errors.join(' '), /Duplicate/)
})

test('user import: role mapping, Others label-only, default password, duplicates', () => {
  const headers = ['ID Number', 'Surname', 'First Name', 'MI', 'Program', 'Role']
  const rows = [['2026001', 'Cruz', 'Ana', 'b', 'BSIT', 'Teacher'], ['2026002', 'Reyes', 'Ben', '', '', 'Dean'], ['2026003', 'Lim', 'Cy', '', '', 'MIS Staff'], ['2026004', 'Diaz', 'Di', '', '', 'Librarian'], ['2026001', 'Dup', 'Du', '', 'BSOA', 'Teacher'], ['123', 'Short', 'Sh', '', '', 'Dean'], ['2026009', 'Old', 'Ol', '', '', 'Dean'], ['2026010', 'Nop', 'Pr', '', '', 'Teacher']]
    .map((values, i) => ({ rowNumber: i + 2, data: mapRow(headers, values, 'users') }))
  const r = validateSimpleRows(rows, 'users', { existing: ['2026009'] })
  assert.equal(r[0].valid, true); assert.equal(r[0].data.full_name, 'Ana B. Cruz'); assert.equal(r[0].data.program, 'BSIT'); assert.equal(r[0].data.password, '2026001')
  assert.equal(r[1].data.role, 'Dean'); assert.equal(r[2].data.role, 'Inventory Staff')
  assert.equal(r[3].valid, true); assert.equal(r[3].data.labelOnly, true); assert.equal(r[3].data.role_other, 'Librarian')
  assert.match(r[4].errors.join(' '), /Duplicate/)
  assert.match(r[5].errors.join(' '), /shorter than 6/)
  assert.match(r[6].errors.join(' '), /already exists/)
  assert.equal(r[7].valid, false, 'Teacher without program is rejected')
})

test('Group 2: laboratory import keeps accepting a custom status without a Reason column value (unchanged behaviour)', () => {
  const headers = ['Laboratory Name', 'Capacity', 'Status', 'Reason']
  const rows = [['Lab Z', '12', 'Under renovation', 'Roof work']].map((values, i) => ({ rowNumber: i + 2, data: mapRow(headers, values, 'laboratories') }))
  const result = validateSimpleRows(rows, 'laboratories', { existing: [] })
  assert.equal(result[0].valid, true); assert.equal(result[0].data.reason, 'Roof work')
})
