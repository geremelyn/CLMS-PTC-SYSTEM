'use strict'
// CP40 focused regression: Dean / Teacher reservation submission against the REAL controller + real SQL transactions
// on an in-memory SQLITE database (NOT MySQL/MariaDB; MySQL-only behaviour such as FOR UPDATE row locks is only
// translated away by the adapter, and the holidays lookup falls back to the built-in baseline).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { createSqliteDb, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const PH = require('../utils/philippineHolidays.js')

function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function setup() {
  const db = createSqliteDb(), s = db.sqlite
  for (const sql of ['ALTER TABLE reservations ADD COLUMN professor_name TEXT', 'ALTER TABLE reservations ADD COLUMN decision_note TEXT', 'ALTER TABLE reservations ADD COLUMN decided_at TEXT', 'ALTER TABLE reservations ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP', 'ALTER TABLE laboratories ADD COLUMN booking_interval INTEGER']) { try { s.exec(sql) } catch { /* column already in adapter schema */ } }
  s.exec(`INSERT INTO users (id, username, full_name, role, status) VALUES (1,'mis','Super Admin','MIS','ACTIVE'),(2,'staff','MIS Staff','Inventory Staff','ACTIVE'),(3,'dean','Dean D','Dean','ACTIVE'),(4,'teach','Teacher T','Teacher','ACTIVE')`)
  s.exec(`INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (10,'Lab 10',40,'OPEN'),(11,'Lab 11',40,'USED')`)
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  return { db, c: require('../controllers/reservationController.js') }
}
// first bookable day at least `days` ahead (> approval cutoff), not Sunday, not a closed holiday
function day(days = 10) { const d = new Date(Date.now() + days * 86400000); const t = () => d.toISOString().slice(0, 10); while (d.getUTCDay() === 0 || !PH.evaluateReservableDate(t(), PH.baselineForDate(t())).ok) d.setUTCDate(d.getUTCDate() + 1); return t() }
function send(fn, user, body, params = {}) { return new Promise(resolve => { const r = res(); const json = r.json.bind(r); r.json = b => { json(b); r.headersSent = true; resolve(r); return r }; fn({ user, body, params, query: {} }, r) }) }
const body = (o = {}) => ({ laboratory_id: 10, reservation_date: day(), start_time: '09:00', end_time: '10:30', purpose: 'Lecture', subject_name: 'IT 101', professor_name: 'Prof X', ...o })
const DEAN = { id: 3, role: 'Dean' }, TEACHER = { id: 4, role: 'Teacher' }, STAFF = { id: 2, role: 'Inventory Staff' }

for (const [label, user] of [['Dean', DEAN], ['Teacher', TEACHER]]) {
  test(`${label} submits a reservation: 201, saved as PENDING under their own id`, async () => {
    const { db, c } = setup(); const b = body(), r = await send(c.createReservation, user, b)
    assert.equal(r.code, 201, JSON.stringify(r.body)); assert.match(r.body.message, /pending approval/)
    const row = db.sqlite.prepare('SELECT * FROM reservations WHERE id = ?').get(r.body.reservation.id)
    assert.equal(row.status, 'PENDING'); assert.equal(row.reserved_by, user.id); assert.equal(row.laboratory_id, 10)
    assert.equal(row.start_time, '09:00:00'); assert.equal(row.end_time, '10:30:00'); assert.equal(row.subject_name, 'IT 101'); assert.equal(row.professor_name, 'Prof X'); assert.equal(row.purpose, 'Lecture')
  })
}
test('invalid submissions are rejected and nothing is saved', async () => {
  const { db, c } = setup()
  for (const [why, over, code] of [['outside hours (06:30)', { start_time: '06:30', end_time: '08:00' }, 400], ['after 9 PM', { start_time: '20:30', end_time: '21:30' }, 400], ['not 30-minute increments', { start_time: '09:10', end_time: '10:30' }, 400], ['end before start', { start_time: '11:00', end_time: '10:00' }, 400], ['missing subject', { subject_name: '' }, 400], ['past date', { reservation_date: '2020-01-06' }, 400], ['unknown laboratory', { laboratory_id: 999 }, 404], ['non-OPEN laboratory', { laboratory_id: 11 }, 400]]) {
    const r = await send(c.createReservation, TEACHER, body(over)); assert.equal(r.code, code, `${why}: ${JSON.stringify(r.body)}`)
  }
  assert.equal(count(db, 'reservations'), 0)
})
test('overlap rejected (409); back-to-back allowed; DECLINED and CANCELLED release the slot', async () => {
  const { db, c } = setup(), date = day()
  const first = await send(c.createReservation, DEAN, body({ reservation_date: date })); assert.equal(first.code, 201)
  db.sqlite.prepare('UPDATE reservations SET status = ? WHERE id = ?').run('APPROVED', first.body.reservation.id) // CP105A: only a decided (APPROVED) reservation blocks
  const overlap = await send(c.createReservation, TEACHER, body({ reservation_date: date, start_time: '10:00', end_time: '11:00' })); assert.equal(overlap.code, 409); assert.equal(overlap.body.code, 'SLOT_TAKEN')
  const back = await send(c.createReservation, TEACHER, body({ reservation_date: date, start_time: '10:30', end_time: '11:30' })); assert.equal(back.code, 201, JSON.stringify(back.body))
  for (const status of ['DECLINED', 'CANCELLED']) {
    db.sqlite.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, first.body.reservation.id)
    const again = await send(c.createReservation, TEACHER, body({ reservation_date: date, start_time: '09:00', end_time: '10:00' })); assert.equal(again.code, 201, `${status}: ${JSON.stringify(again.body)}`)
    db.sqlite.prepare('UPDATE reservations SET status = ? WHERE id = ?').run('CANCELLED', again.body.reservation.id)
  }
})
test('CP81: a request for tomorrow (inside the old 3-day window) is saved as PENDING, not auto-declined', async () => {
  const { db, c } = setup(); const soon = day(1)
  const r = await send(c.createReservation, TEACHER, body({ reservation_date: soon, start_time: '20:00', end_time: '21:00' }))
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.auto_declined, false)
  const row = db.sqlite.prepare('SELECT status, decision_note FROM reservations WHERE id = ?').get(r.body.reservation.id); assert.equal(row.status, 'PENDING'); assert.equal(row.decision_note, null)
})
test('MIS Staff approves and declines a Dean/Teacher submission', async () => {
  const { db, c } = setup(), date = day()
  const a = await send(c.createReservation, DEAN, body({ reservation_date: date })); const d = await send(c.createReservation, TEACHER, body({ reservation_date: date, start_time: '13:00', end_time: '14:00' }))
  const ok = await send(c.decideReservation, STAFF, { decision: 'APPROVED' }, { id: String(a.body.reservation.id) }); assert.equal(ok.code, 200, JSON.stringify(ok.body))
  const no = await send(c.decideReservation, STAFF, { decision: 'DECLINED', decision_note: 'Not available' }, { id: String(d.body.reservation.id) }); assert.equal(no.code, 200, JSON.stringify(no.body))
  assert.equal(db.sqlite.prepare('SELECT status FROM reservations WHERE id = ?').get(a.body.reservation.id).status, 'APPROVED')
  assert.equal(db.sqlite.prepare('SELECT status FROM reservations WHERE id = ?').get(d.body.reservation.id).status, 'DECLINED')
})
