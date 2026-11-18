'use strict'
// CP69: custom role keeps its own displayed name; Teacher Program "Others" stores/displays the exact custom program name.
// Mocked db / pure functions / static source checks. No real MySQL (the VARCHAR widening in ensureSchema is NOT executed here) and no browser.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const client = path.join(__dirname, '..', '..', 'client', 'src')
const { validateManagedUser } = require('../utils/userValidation.js')
const { validateSimpleRows } = require('../utils/simpleImportRows.js')
const base = { surname: 'Cruz', first_name: 'Ana', username: 'acruz1', password: 'secret1' }

test('Teacher + Program Others: the exact custom program name is saved, never the word "Others"', () => {
  const v = validateManagedUser({ ...base, role: 'Teacher', program: 'Others', program_other: '  BS  Nursing ' }, { passwordRequired: true })
  assert.equal(v.error, null); assert.equal(v.values.role, 'Teacher'); assert.equal(v.values.program, 'BS Nursing')
})
test('Program Others needs a name, rejects the literal word Others and >100 chars; BSIT/BSOA unchanged; non-teachers get no program', () => {
  assert.match(validateManagedUser({ ...base, role: 'Teacher', program: 'Others', program_other: ' ' }, { passwordRequired: true }).error, /custom program name/i)
  assert.match(validateManagedUser({ ...base, role: 'Teacher', program: 'Others', program_other: 'others' }, { passwordRequired: true }).error, /actual program name/i)
  assert.match(validateManagedUser({ ...base, role: 'Teacher', program: 'Others', program_other: 'x'.repeat(101) }, { passwordRequired: true }).error, /100 characters/)
  assert.equal(validateManagedUser({ ...base, role: 'Teacher', program: 'BSOA' }, { passwordRequired: true }).values.program, 'BSOA')
  assert.match(validateManagedUser({ ...base, role: 'Teacher', program: 'Nursing' }, { passwordRequired: true }).error, /Select a Program/)
  assert.equal(validateManagedUser({ ...base, role: 'Dean', program: 'Others', program_other: 'X' }, { passwordRequired: true }).values.program, null)
})
test('custom ROLE and custom PROGRAM stay separate: role Others keeps role_other label, program stays null', () => {
  const v = validateManagedUser({ ...base, role: 'Others', role_other: 'Laboratory Assistant', program: 'Others', program_other: 'Nursing' }, { passwordRequired: true })
  assert.equal(v.values.role, 'Others'); assert.equal(v.values.role_other, 'Laboratory Assistant'); assert.equal(v.values.program, null)
})
test('createUser inserts the exact program name and the custom role label (mocked db)', async () => {
  const calls = []
  const mock = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  mock('../database/db.js', { query(sql, values, cb) { const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ n, values }); if (n.startsWith('SELECT id FROM users')) return cb(null, []); cb(null, { insertId: 9 }) } })
  mock('../utils/auditLogger.js', { logAudit() {} })
  const p = path.resolve(__dirname, '../controllers/userController.js'); delete require.cache[p]
  const send = body => new Promise(resolve => { const r = { status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }) } }; require(p).createUser({ body, user: { id: 1 } }, r) })
  const t = await send({ ...base, role: 'Teacher', program: 'Others', program_other: 'BS Nursing' })
  assert.equal(t.code, 201); assert.equal(t.body.user.program, 'BS Nursing')
  assert.ok(calls.find(c => c.n.startsWith('INSERT INTO users')).values.includes('BS Nursing'))
  const o = await send({ ...base, username: 'lab1', role: 'Others', role_other: 'Laboratory Assistant' })
  assert.equal(o.body.user.role, 'Others'); assert.equal(o.body.user.role_other, 'Laboratory Assistant')
})
test('Excel import keeps a custom program name exactly (not upper-cased) and BSIT-Teacher still works', () => {
  const rows = validateSimpleRows([{ data: { username: 'T10001', surname: 'S', first_name: 'F', role: 'Teacher', program: 'BS Nursing' } }, { data: { username: 'T10002', surname: 'S', first_name: 'F', role: 'BSIT-Teacher' } }, { data: { username: 'T10003', surname: 'S', first_name: 'F', role: 'Teacher', program: 'bsoa' } }], 'users')
  assert.deepEqual(rows.map(r => [r.valid, r.data.role, r.data.program]), [[true, 'Teacher', 'BS Nursing'], [true, 'Teacher', 'BSIT'], [true, 'Teacher', 'BSOA']])
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'simpleImportController.js'), 'utf8')
  assert.doesNotMatch(src, /\$\{d\.program\}-Teacher/)
})
test('schema widens users.program additively (existing values kept)', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'database', 'ensureSchema.js'), 'utf8')
  assert.match(s, /ALTER TABLE users MODIFY COLUMN program VARCHAR\(100\) NULL/)
})
test('display: custom role name shows instead of Others/Teacher (helper, report labels, list query, pages)', async () => {
  const { displayRoleName, customRoleName } = await import(path.join(client, 'utils', 'roleDisplay.js'))
  assert.equal(displayRoleName('Others', 'Laboratory Assistant'), 'Laboratory Assistant'); assert.equal(customRoleName('Teacher', 'x'), null)
  assert.equal(displayRoleName('Teacher'), 'Teacher'); assert.equal(displayRoleName('Inventory Staff'), 'MIS Staff'); assert.equal(displayRoleName('MIS'), 'Super Admin')
  const { reportRoleLabel, makeReportViewRows } = await import(path.join(client, 'utils', 'reportFormatting.mjs'))
  assert.equal(reportRoleLabel('Others', null, 'Laboratory Assistant'), 'Laboratory Assistant'); assert.equal(reportRoleLabel('Teacher', 'BSIT'), 'BSIT-Teacher')
  const rows = makeReportViewRows([{ id: 1, reservation_date: '2026-11-09', start_time: '08:00', end_time: '09:00', reserved_by: 'Ana Cruz', reserved_by_role: 'Others', reserved_by_role_other: 'Laboratory Assistant' }], 'reservations')
  assert.match(rows[0]['Reserved By'], /Laboratory Assistant/); assert.doesNotMatch(rows[0]['Reserved By'], /Others|Teacher/)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'controllers', 'reservationController.js'), 'utf8'), /users\.role_other AS reserved_by_role_other/)
  const dash = fs.readFileSync(path.join(client, 'pages', 'TeacherDashboard.jsx'), 'utf8')
  assert.match(dash, /customRoleName\(user\?\.role, user\?\.role_other\) \|\| 'Teacher'/); assert.match(dash, /\{roleName\.toUpperCase\(\)\} DASHBOARD/); assert.doesNotMatch(dash, /Welcome Teacher/) // greeting is now welcomeGreeting(user) (CP84)
})
test('Users form: Program offers Others with a custom-name field and sends program_other; edit restores a custom program', () => {
  const s = fs.readFileSync(path.join(client, 'pages', 'Users.jsx'), 'utf8')
  assert.match(s, /<option value="Others">Others<\/option>\s*<\/select>\s*\{program === 'Others'/)
  assert.equal((s.match(/program_other: role === 'Teacher' && program === 'Others' \? programOther : null/g) || []).length, 2)
  assert.match(s, /setProgram\(custom \? 'Others'/)
})
