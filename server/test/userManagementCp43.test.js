'use strict'
// CP43 focused tests. SQLite-backed where noted (NOT MySQL); no live MySQL/MariaDB is available in this environment.
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateManagedUser } = require('../utils/userValidation.js')
const { validateSimpleRows } = require('../utils/simpleImportRows.js')
const fs = require('node:fs'), path = require('node:path')

test('name parts compose full_name; MI normalised (pure validation)', () => {
  const r = validateManagedUser({ surname: 'Dela Cruz', first_name: 'Juan', middle_initial: 'p.', username: '2024-001', password: 'secret1', role: 'Dean' }, { passwordRequired: true })
  assert.equal(r.error, null); assert.equal(r.values.full_name, 'Juan P. Dela Cruz'); assert.equal(r.values.middle_initial, 'P')
})
test('role keys: MIS Staff label maps to Inventory Staff; custom label to Others (pure)', () => {
  const rows = validateSimpleRows([{ data: { username: 'A1B2C3', surname: 'S', first_name: 'F', role: 'MIS Staff' } }, { data: { username: 'D4E5F6', surname: 'S', first_name: 'F', role: 'Librarian' } }, { data: { username: 'G7H8I9', surname: 'S', first_name: 'F', role: 'Teacher', program: 'BSIT' } }], 'users')
  assert.deepEqual(rows.map(r => r.data.role), ['Inventory Staff', 'Others', 'Teacher']); assert.equal(rows[1].data.role_other, 'Librarian')
})
test('import rejects duplicate ID numbers (existing and in-file)', () => {
  const rows = validateSimpleRows([{ data: { username: 'x12345', surname: 'S', first_name: 'F', role: 'Dean' } }, { data: { username: 'X12345', surname: 'S', first_name: 'F', role: 'Dean' } }], 'users', { existing: ['x12345'] })
  assert.ok(rows.every(r => !r.valid))
})
test('source checks: Super Admin label + search covers custom role and name parts; create response has name fields', () => {
  const root = path.join(__dirname, '..', '..', 'client', 'src')
  const page = fs.readFileSync(path.join(root, 'pages', 'Users.jsx'), 'utf8')
  const pdf = fs.readFileSync(path.join(root, 'utils', 'usersPdf.js'), 'utf8')
  assert.match(pdf, /u\.role === 'MIS' \? 'Super Admin'/)
  assert.match(page, /u\.role_other, u\.program/); assert.match(page, /u\.surname, u\.first_name/)
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'userController.js'), 'utf8')
  assert.match(ctl, /user: \{ id: createdId, full_name, surname, first_name, middle_initial/)
})
