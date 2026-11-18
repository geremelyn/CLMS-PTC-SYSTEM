'use strict'
// CP42 MySQL/MariaDB compatibility audit tests. NO live MySQL/MariaDB was available, so:
//  - the length-rule test runs the real controller on in-memory SQLITE (which cannot itself enforce VARCHAR limits - that is
//    exactly why the controller must validate them before MySQL strict mode turns them into a 500);
//  - the other tests are STATIC assertions on the schema text and on the exact SQL strings the controller sends to MySQL/MariaDB.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createSqliteDb, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const PH = require('../utils/philippineHolidays.js')

const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const schema = read('../database/ensureSchema.js')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function setup() {
  const db = createSqliteDb(), s = db.sqlite
  for (const sql of ['ALTER TABLE reservations ADD COLUMN professor_name TEXT', 'ALTER TABLE reservations ADD COLUMN decision_note TEXT', 'ALTER TABLE laboratories ADD COLUMN booking_interval INTEGER']) { try { s.exec(sql) } catch { /* exists */ } }
  s.exec("INSERT INTO users (id, username, full_name, role, status) VALUES (3,'dean','Dean D','Dean','ACTIVE'),(4,'teach','Teacher T','Teacher','ACTIVE'); INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (10,'Lab 10',40,'OPEN')")
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  return { db, c: require('../controllers/reservationController.js') }
}
const day = () => { const d = new Date(Date.now() + 12 * 86400000); const t = () => d.toISOString().slice(0, 10); while (d.getUTCDay() === 0 || !PH.evaluateReservableDate(t(), PH.baselineForDate(t())).ok) d.setUTCDate(d.getUTCDate() + 1); return t() }
const send = (fn, user, body) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); r.headersSent = true; resolve(r); return r }; fn({ user, body, params: {}, query: {} }, r) })
const body = (o = {}) => ({ laboratory_id: 10, reservation_date: day(), start_time: '09:00', end_time: '10:00', purpose: 'Lecture', subject_name: 'IT 101', professor_name: 'Prof X', ...o })

test('over-long purpose / subject / professor name -> clear 400 (not a MySQL strict-mode 500); exact limits accepted; nothing partially saved', async () => {
  const { db, c } = setup()
  for (const [field, limit] of [['purpose', 255], ['subject_name', 150], ['professor_name', 150]]) {
    const bad = await send(c.createReservation, field === 'professor_name' ? { id: 4, role: 'Teacher' } : { id: 3, role: 'Dean' }, body({ [field]: 'x'.repeat(limit + 1) }))
    assert.equal(bad.code, 400, `${field}: ${JSON.stringify(bad.body)}`); assert.match(bad.body.message, /characters or fewer/)
  }
  assert.equal(count(db, 'reservations'), 0)
  const ok = await send(c.createReservation, { id: 4, role: 'Teacher' }, body({ purpose: 'p'.repeat(255), subject_name: 's'.repeat(150), professor_name: 'n'.repeat(150) }))
  assert.equal(ok.code, 201, JSON.stringify(ok.body))
  assert.equal(db.sqlite.prepare('SELECT length(professor_name) AS n FROM reservations').get().n, 150)
})
test('controller length limits match the reservations column sizes in the schema', () => {
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS reservations'), schema.indexOf('ENGINE=InnoDB', schema.indexOf('CREATE TABLE IF NOT EXISTS reservations')))
  assert.match(table, /purpose VARCHAR\(255\)/); assert.match(table, /subject_name VARCHAR\(150\)/); assert.match(table, /professor_name VARCHAR\(150\)/)
  const ctl = read('../controllers/reservationController.js')
  assert.match(ctl, /normalizedPurpose\.length > 255/); assert.match(ctl, /normalizedSubjectName\.length > 150/); assert.match(ctl, /normalizedProfessorName\.length > 150/)
})
test('schema: TIME/DATE types, full status ENUM, InnoDB, and the conflict-check index is created portably (information_schema, not MariaDB-only IF NOT EXISTS)', () => {
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS reservations'))
  assert.match(table, /reservation_date DATE NOT NULL/); assert.match(table, /start_time TIME NOT NULL/); assert.match(table, /end_time TIME NOT NULL/)
  assert.match(table, /ENUM\('PENDING','APPROVED','DECLINED','COMPLETED','CANCELLED'\)/); assert.match(table, /ENGINE=InnoDB/)
  assert.match(schema, /idx_reservations_lab_date_status \(laboratory_id, reservation_date, status\)/)
  assert.match(schema, /information_schema\.statistics/); assert.ok(!/CREATE INDEX IF NOT EXISTS/i.test(schema))
})
test('slot rules as the SQL states them: Pending/Approved/Completed block; Declined/Cancelled release; strict < / > allows back-to-back', () => {
  const ctl = require('../controllers/reservationController.js'), policy = require('../config/reservationPolicy.js')
  assert.equal(ctl.BLOCKING_STATUS_SQL, "'PENDING','APPROVED','COMPLETED'"); assert.ok(!/DECLINED|CANCELLED/.test(ctl.BLOCKING_STATUS_SQL)); assert.equal(policy.conflictStatusSql, "'PENDING','APPROVED'")
  assert.equal(ctl.OVERLAP_SQL, 'start_time < ? AND end_time > ?') // params are (newEnd, newStart): 09:00-10:00 vs new 10:00-11:00 -> 09:00<11:00 AND 10:00>10:00 = false
  const overlaps = (exStart, exEnd, newStart, newEnd) => exStart < newEnd && exEnd > newStart // same predicate in JS on HH:MM:SS strings
  assert.equal(overlaps('09:00:00', '10:00:00', '10:00:00', '11:00:00'), false); assert.equal(overlaps('09:00:00', '10:00:00', '09:30:00', '10:30:00'), true)
})
test('CP106: the CP81 auto-decline expiry is gone; slots - DECLINED / CANCELLED are not blocking, no expiry wiring at start-up or in the list', () => {
  const X = require('../utils/pendingReservationExpiry.js')
  assert.equal(X.EXPIRE_SQL, undefined); assert.equal(X.startPendingReservationExpiry, undefined)
  assert.ok(X.isAutoDeclinedNote('Automatically declined: no MIS decision within 3 days of submission.')); assert.ok(X.isAutoCancelledNote('Automatically cancelled: no MIS decision within 3 days of submission.'))
  const blocking = require('../controllers/reservationController.js').BLOCKING_STATUS_SQL; assert.ok(!blocking.includes('DECLINED') && !blocking.includes('CANCELLED'))
  assert.doesNotMatch(read('../server.js'), /startPendingReservationExpiry|expirePendingReservations|scheduling cutoff/)
  const ctrl = read('../controllers/reservationController.js'); assert.doesNotMatch(ctrl, /EXPIRE_SQL|EXPIRE_PARAMS|scheduling cutoff|AUTO_CANCEL_SQL|approvalCutoffDays/)
})
test('operating hours 07:00-21:00 and 30-minute grid come from one config and are enforced before any SQL', () => {
  const T = require('../config/reservationTime.js')
  assert.equal(T.OPEN, '07:00'); assert.equal(T.CLOSE, '21:00'); assert.equal(T.STEP_MINUTES, 30)
  for (const [a, b, ok] of [['07:00', '21:00', true], ['06:30', '08:00', false], ['20:30', '21:30', false], ['09:15', '10:00', false], ['10:00', '10:00', false]]) assert.equal(T.validateTimeRange(a, b).ok, ok, `${a}-${b}`)
})
