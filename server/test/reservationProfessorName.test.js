'use strict'
// CP41 regression: an account whose full_name is blank but which has separate surname / first name / middle initial
// must still get a professor name on the Reserve form (composed from the saved parts), while an account with no name
// data at all stays blocked. Login must return the parts so the client can do this. MOCKED/SQLITE only (no MySQL).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/reservationTime.js')).href)

test('describeProfessor: full_name wins; blank full_name falls back to saved name parts; nothing is invented', async () => {
  const { describeProfessor } = await load()
  assert.deepEqual(describeProfessor({ role: 'Teacher', full_name: 'Ana M. Cruz', surname: 'X', first_name: 'Y' }), { name: 'Ana M. Cruz', role: 'Teacher' })
  assert.equal(describeProfessor({ role: 'Dean', full_name: '', surname: 'Reyes', first_name: 'Maria', middle_initial: 'l.' }).name, 'Maria L. Reyes')
  assert.equal(describeProfessor({ role: 'Teacher', full_name: '   ', surname: 'Santos', first_name: 'Jose', middle_initial: null }).name, 'Jose Santos')
  assert.equal(describeProfessor({ role: 'Teacher', full_name: null, surname: 'Santos' }).name, '', 'surname alone is not enough: still blocked')
  assert.equal(describeProfessor({ role: 'Teacher' }).name, '')
  assert.equal(describeProfessor(null).name, '')
})

test('login response includes surname / first_name / middle_initial', async () => {
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const row = { id: 9, full_name: '', surname: 'Reyes', first_name: 'Maria', middle_initial: 'L', username: 'dean1', password: 'hash:pw', role: 'Dean', status: 'ACTIVE', must_change_password: 0 }
  stub('../database/db.js', { query: (sql, p, cb) => cb(null, [row]) }); stub('../utils/auditLogger.js', { logAudit() {} })
  stub('../utils/sessionToken.js', { createSessionToken: () => 'tok', revokeSessionToken: (t, cb) => cb() })
  delete require.cache[path.resolve(__dirname, '../controllers/authController.js')]
  // The fake row password is 'hash:pw'. Stub bcrypt here so this test does not depend on which bcrypt (real or stand-in) is installed.
  const originalLoad = Module._load
  Module._load = function (request, ...rest) { return request === 'bcrypt' ? { compare: async (plain, hashed) => hashed === `hash:${plain}`, hash: async value => `hash:${value}` } : originalLoad.call(this, request, ...rest) }
  let login
  try { ({ login } = require('../controllers/authController.js')) } finally { Module._load = originalLoad }
  const out = await new Promise(resolve => { const r = { code: 200, status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }) } }; login({ body: { username: 'dean1', password: 'pw' } }, r) })
  assert.equal(out.code, 200, JSON.stringify(out.body))
  assert.deepEqual([out.body.user.surname, out.body.user.first_name, out.body.user.middle_initial], ['Reyes', 'Maria', 'L'])
})

test('end to end: composed professor name is accepted by the reservation API and saved', async () => {
  const { describeProfessor } = await load()
  const { createSqliteDb, res } = require('./helpers/sqliteMysqlAdapter.js')
  const db = createSqliteDb(), s = db.sqlite
  for (const sql of ['ALTER TABLE reservations ADD COLUMN professor_name TEXT', 'ALTER TABLE reservations ADD COLUMN decision_note TEXT', 'ALTER TABLE laboratories ADD COLUMN booking_interval INTEGER']) { try { s.exec(sql) } catch { /* exists */ } }
  s.exec("INSERT INTO users (id, username, full_name, role, status) VALUES (9,'dean1','','Dean','ACTIVE'); INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (10,'Lab 10',40,'OPEN')")
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  const c = require('../controllers/reservationController.js')
  const PH = require('../utils/philippineHolidays.js')
  const d = new Date(Date.now() + 12 * 86400000); const t = () => d.toISOString().slice(0, 10); while (d.getUTCDay() === 0 || !PH.evaluateReservableDate(t(), PH.baselineForDate(t())).ok) d.setUTCDate(d.getUTCDate() + 1)
  const professor = describeProfessor({ role: 'Dean', full_name: '', surname: 'Reyes', first_name: 'Maria', middle_initial: 'L' })
  const out = await new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); r.headersSent = true; resolve(r); return r }
    c.createReservation({ user: { id: 9, role: 'Dean' }, query: {}, params: {}, body: { laboratory_id: 10, reservation_date: t(), start_time: '09:00', end_time: '10:00', purpose: 'Lecture', subject_name: 'IT 101', professor_name: professor.name } }, r) })
  assert.equal(out.code, 201, JSON.stringify(out.body))
  assert.equal(s.prepare('SELECT professor_name FROM reservations WHERE id = ?').get(out.body.reservation.id).professor_name, 'Maria L. Reyes')
})
