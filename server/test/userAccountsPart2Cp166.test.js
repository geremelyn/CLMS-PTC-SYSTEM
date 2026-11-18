'use strict'
// CP166 Part 2 - (1) MIS Head row shows the account's OWN stored name; (2) Teacher program "Others" popup + save + display.
// OFFLINE: client helpers are imported as real ES modules; the optional SQL is executed on SQLite (NOT MySQL); the Users page is checked as source text.
// NOT covered: real MySQL, the real browser UI (no browser test was run for this checkpoint).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const client = path.resolve(__dirname, '../../client/src')
const read = f => fs.readFileSync(path.join(client, f), 'utf8')
const load = () => import(path.join(client, 'utils', 'usersPdf.js'))
const { validateManagedUser } = require('../utils/userValidation.js')

test('MIS Head row shows the stored name (surname / first name columns), not the hardcoded "Super Admin"', async () => {
  const { userNameParts } = await load()
  assert.deepEqual(userNameParts({ role: 'MIS', full_name: 'Julius Codilan', surname: 'Codilan', first_name: 'Julius', middle_initial: null }), { surname: 'Codilan', first: 'Julius', mi: '' })
  assert.deepEqual(userNameParts({ role: 'MIS', full_name: 'Julius Codilan' }), { surname: 'Codilan', first: 'Julius', mi: '' }, 'derived from full_name when the split columns are empty')
  assert.deepEqual(userNameParts({ role: 'MIS', full_name: 'Julius Codilan', surname: 'Codilan', first_name: 'Julius', middle_initial: 'A' }).mi, 'A')
})
test('a missing / generic placeholder name on the MIS account keeps the previous "Super Admin" display (nothing invented)', async () => {
  const { userNameParts } = await load()
  for (const full_name of ['Super Admin', 'super  admin', 'MIS', 'MIS Head', 'Admin', 'Administrator', '', null, undefined]) {
    assert.deepEqual(userNameParts({ role: 'MIS', full_name }), { surname: 'Super Admin', first: '', mi: '' }, String(full_name))
  }
})
test('no name is hardcoded: other accounts are never affected, even one called "Julius Codilan" or "Super Admin"', async () => {
  const { userNameParts } = await load()
  assert.deepEqual(userNameParts({ role: 'Teacher', full_name: 'Super Admin' }), { surname: 'Admin', first: 'Super', mi: '' })
  assert.deepEqual(userNameParts({ role: 'Dean', full_name: 'Ana Reyes', surname: 'Reyes', first_name: 'Ana', middle_initial: 'B' }), { surname: 'Reyes', first: 'Ana', mi: 'B' })
  for (const f of ['utils/usersPdf.js', 'pages/Users.jsx']) assert.ok(!/julius|codilan/i.test(read(f)), `${f} must not contain a hardcoded person name`)
})
test('Users table and Save-as-PDF use the same helper; Role column still says Super Admin for MIS', async () => {
  const ui = read('pages/Users.jsx'), pdf = read('utils/usersPdf.js')
  assert.match(ui, /userNameParts\(u\)\.surname/); assert.match(ui, /userNameParts\(u\)\.first/); assert.doesNotMatch(ui, /u\.role === 'MIS' \? 'Super Admin' : nameParts/)
  const { buildUsersPdfHtml, userRoleLabel } = await load()
  const html = buildUsersPdfHtml([{ id: 1, username: 'mis', role: 'MIS', full_name: 'Julius Codilan', surname: 'Codilan', first_name: 'Julius', status: 'ACTIVE' }, { id: 2, username: 't1', role: 'Teacher', full_name: 'Ana Reyes', program: 'BSCS', status: 'ACTIVE' }], { now: new Date('2026-11-14T08:00:00Z') })
  assert.match(html, /<td>Codilan<\/td><td>Julius<\/td>/); assert.match(html, /<td>Super Admin<\/td><td class="c-stat">ACTIVE<\/td>/, 'role column unchanged')
  assert.match(html, /<td>Reyes<\/td><td>Ana<\/td>/); assert.equal(userRoleLabel({ role: 'MIS' }), 'Super Admin')
  assert.match(pdf, /export function userNameParts/)
})
test('MIS row keeps its protections: no checkbox, no Edit/Reset/Deactivate/Delete (UI) and the server refuses to edit MIS', () => {
  const ui = read('pages/Users.jsx')
  assert.match(ui, /disabled=\{u\.role === 'MIS'\}/); assert.match(ui, /\{u\.role !== 'MIS' && \(/)
  const ctl = fs.readFileSync(path.resolve(__dirname, '../controllers/userController.js'), 'utf8')
  assert.match(ctl, /MIS account cannot be edited here/)
})
test('optional SQL: fills the name ONLY for a single MIS account with an empty/generic name; never overwrites a real name or touches others (SQLite run, not MySQL)', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../database/migrations/2026-11-14_cp166_mis_head_name_OPTIONAL.sql'), 'utf8')
  const update = sql.split(';').map(x => x.trim()).find(x => /^UPDATE users/i.test(x.replace(/^(--.*\n)+/g, '').trim()) || /\nUPDATE users/.test('\n' + x))
  const stmt = update.slice(update.indexOf('UPDATE users'))
  const { DatabaseSync } = require('node:sqlite')
  const make = rows => { const d = new DatabaseSync(':memory:'); d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, full_name TEXT, surname TEXT, first_name TEXT, middle_initial TEXT)'); const ins = d.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)'); rows.forEach(r => ins.run(...r)); return d }
  const names = d => d.prepare('SELECT id, full_name, surname, first_name FROM users ORDER BY id').all().map(r => `${r.id}:${r.full_name}|${r.surname}|${r.first_name}`)
  let d = make([[1, 'admin', 'MIS', 'Super Admin', null, null, null], [2, 'a', 'Teacher', 'Super Admin', null, null, null], [3, 'b', 'Dean', 'Ana Reyes', 'Reyes', 'Ana', 'B']]); d.exec(stmt)
  assert.deepEqual(names(d), ['1:Julius Codilan|Codilan|Julius', '2:Super Admin|null|null', '3:Ana Reyes|Reyes|Ana'], 'only the MIS account changes')
  d.exec(stmt); assert.deepEqual(names(d)[0], '1:Julius Codilan|Codilan|Julius', 'idempotent')
  d = make([[1, 'admin', 'MIS', 'Juan Dela Cruz', null, null, null]]); d.exec(stmt); assert.deepEqual(names(d), ['1:Juan Dela Cruz|null|null'], 'a real stored name is never overwritten')
  d = make([[1, 'admin', 'MIS', 'Super Admin', 'Admin', 'Super', null]]); d.exec(stmt); assert.deepEqual(names(d), ['1:Super Admin|Admin|Super'], 'saved surname/first name are respected')
  d = make([[1, 'a', 'MIS', 'Super Admin', null, null, null], [2, 'b', 'MIS', 'MIS', null, null, null]]); d.exec(stmt); assert.deepEqual(names(d), ['1:Super Admin|null|null', '2:MIS|null|null'], 'two MIS accounts: nothing changes')
  assert.ok(!/^\s*(UPDATE|INSERT|DELETE)/im.test(read('pages/Users.jsx')), 'sanity')
  assert.ok(!fs.readFileSync(path.resolve(__dirname, '../database/ensureSchema.js'), 'utf8').includes('Codilan'), 'not run automatically')
})

test('Teacher program: choosing Others opens a popup (prompt) for the program name; cancel keeps the previous program', () => {
  const ui = read('pages/Users.jsx')
  assert.match(ui, /async function askProgramName/); assert.match(ui, /title: 'Program'/)
  assert.match(ui, /if \(picked === 'Others'\) \{\s*\/\/ Others opens a popup for the program name/)
  assert.match(ui, /const chosen = await askProgramName\(program === 'Others' \? programOther : ''\);\s*if \(!chosen\) return;/)
  assert.doesNotMatch(ui, /aria-label="Custom program name"/, 'the old inline text box is replaced by the popup')
  for (const text of ['cannot be empty', '100 characters or fewer', 'instead of the word']) assert.ok(ui.includes(text), text)
  assert.match(ui, /\['BSIT', 'BSOA'\]\.find/); assert.match(ui, /Program: <strong>/)
  assert.match(ui, /<option value="BSIT">BSIT<\/option>/); assert.match(ui, /<option value="BSOA">BSOA<\/option>/)
})
test('Teacher program: the entered name is sent as program + program_other and still required for Others (create and edit)', () => {
  const ui = read('pages/Users.jsx')
  assert.equal((ui.match(/program_other: role === 'Teacher' && program === 'Others' \? programOther : null/g) || []).length, 2, 'POST and PUT')
  assert.match(ui, /Enter the custom program name for Others\./); assert.match(ui, /Select a Program \(BSIT, BSOA or Others\) for teacher accounts\./)
  assert.match(ui, /setProgram\(custom \? 'Others' : \(u\.program \|\| ''\)\); setProgramOther\(custom \? u\.program : ''\)/, 'edit re-opens a saved custom program as Others + name')
})
test('Teacher program (server): the exact program name is stored, never the word Others; bad values are refused', () => {
  const base = { full_name: 'Ana Reyes', surname: 'Reyes', first_name: 'Ana', username: 'areyes', password: 'Secret123!', role: 'Teacher' }
  const ok = validateManagedUser({ ...base, program: 'Others', program_other: '  BS  Computer   Science ' })
  assert.equal(ok.error, null); assert.equal(ok.values.program, 'BS Computer Science')
  assert.equal(validateManagedUser({ ...base, program: 'BSIT' }).values.program, 'BSIT')
  assert.equal(validateManagedUser({ ...base, program: 'BSOA', program_other: 'ignored' }).values.program, 'BSOA')
  for (const bad of ['', '   ', 'Others', 'others', 'x'.repeat(101)]) assert.ok(validateManagedUser({ ...base, program: 'Others', program_other: bad }).error, JSON.stringify(bad))
  assert.equal(validateManagedUser({ ...base, program: '' }).error, 'Select a Program (BSIT, BSOA or Others) for teacher accounts.')
  assert.equal(validateManagedUser({ ...base, role: 'Dean', program: 'Others', program_other: 'BSCS' }).values.program, null, 'program only applies to Teachers')
})
test('Teacher program display: Program column and role label show the saved name (screen + PDF)', async () => {
  const { buildUsersPdfHtml, userRoleLabel } = await load()
  assert.equal(userRoleLabel({ role: 'Teacher', program: 'BS Computer Science' }), 'BS Computer Science-Teacher')
  const html = buildUsersPdfHtml([{ id: 2, username: 't1', role: 'Teacher', full_name: 'Ana Reyes', program: 'BS Computer Science', status: 'ACTIVE' }], { now: new Date('2026-11-14T08:00:00Z') })
  assert.match(html, /<td>BS Computer Science<\/td><td>BS Computer Science-Teacher<\/td>/)
  assert.match(read('pages/Users.jsx'), /<td>\{u\.program \|\| '—'\}<\/td>/)
})
test('Part 1 custom-role UI is untouched (popup, saved roles in dropdown, unused-role delete)', () => {
  const ui = read('pages/Users.jsx')
  for (const part of ['askCustomRoleName', "title: 'Custom role'", 'unused-custom-roles', 'deleteSavedCustomRole', "api.delete(`/users/custom-roles/"]) assert.ok(ui.includes(part), part)
})
