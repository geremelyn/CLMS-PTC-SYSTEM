'use strict'
// CP106 (Sir JC): PENDING reservations are never changed automatically - no 3-day expiry, no start-time expiry. They stay PENDING until MIS / authorized
// MIS Staff decides them manually. CP105A/B/C behaviour is preserved.
// TEST TYPE: REAL controller + real SQL against an in-memory SQLITE database (NOT MySQL/MariaDB - none is available in this environment).
// MySQL-specific behaviour (real FOR UPDATE row locks, real NOW(), real ENUM/DATETIME types) is NOT exercised: the adapter strips FOR UPDATE.
// The "mocked" part is only the audit logger (captured here) and the DB driver.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { createSqliteDb, res } = require('./helpers/sqliteMysqlAdapter.js')
const PH = require('../utils/philippineHolidays.js')

function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function day(n = 10) { const d = new Date(Date.now() + n * 86400000); const t = () => d.toISOString().slice(0, 10); while (d.getUTCDay() === 0 || !PH.evaluateReservableDate(t(), PH.baselineForDate(t())).ok) d.setUTCDate(d.getUTCDate() + 1); return t() }
const D1 = day(10), D2 = day(12)
function setup(opts) {
  const db = createSqliteDb(opts), s = db.sqlite, audit = []
  s.function('DATE_FORMAT', { varargs: true }, value => (value == null ? null : String(value).slice(0, 10))) // the list query passes DATE_FORMAT(date, '%Y-%m-%d') (2 args)
  for (const sql of ['ALTER TABLE reservations ADD COLUMN professor_name TEXT', 'ALTER TABLE reservations ADD COLUMN decision_note TEXT', 'ALTER TABLE reservations ADD COLUMN decided_at TEXT', 'ALTER TABLE reservations ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP', 'ALTER TABLE reservations ADD COLUMN cancellation_note TEXT', 'ALTER TABLE reservations ADD COLUMN cancelled_at TEXT', 'ALTER TABLE laboratories ADD COLUMN booking_interval INTEGER']) { try { s.exec(sql) } catch { /* already in adapter schema */ } }
  s.exec(`INSERT INTO users (id, username, full_name, role, status) VALUES (1,'mis','Super Admin','MIS','ACTIVE'),(2,'staff','MIS Staff','Inventory Staff','ACTIVE'),(3,'dean','Dean D','Dean','ACTIVE'),(4,'teach','Teacher T','Teacher','ACTIVE'),(5,'teach2','Teacher Two','Teacher','ACTIVE')`)
  s.exec(`INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (10,'Lab 10',40,'OPEN'),(11,'Lab 11',40,'OPEN')`)
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit(...a) { audit.push(a) } })
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  return { db, audit, c: require('../controllers/reservationController.js') }
}
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 2, role: 'Inventory Staff' }, TEACHER = { id: 4, role: 'Teacher' }
let nextId = 1
function add(db, { lab = 10, date = D1, start, end, status = 'PENDING', by = 4, at = '2026-11-01 08:00:00', id: fixedId }) {
  const id = fixedId ?? nextId++
  db.sqlite.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name, purpose, professor_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, lab, by, date, start + ':00', end + ':00', status, 'S', 'P', 'Prof', at)
  return id
}
const row = (db, id) => db.sqlite.prepare('SELECT * FROM reservations WHERE id = ?').get(id)
const statuses = (db, ids) => ids.map(i => row(db, i).status)
const decide = (c, id, decision, user = MIS, note) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.decideReservation({ params: { id: String(id) }, body: { decision, decision_note: note }, user }, r) })



const fs = require('node:fs')
const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8')
const listAs = (c, user) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.getReservations({ user, query: {}, body: {} }, r) })
const OLD = '2026-08-01 08:00:00'  // ~100 days before "now" in these tests
const pastDate = () => { const d = new Date(Date.now() - 20 * 86400000); return d.toISOString().slice(0, 10) }

test('old PENDING reservations (created long ago, 3+ days, start time already passed, date in the past) stay PENDING when the reservation list is loaded', async () => {
  const { db, c } = setup()
  try { db.sqlite.exec('ALTER TABLE users ADD COLUMN role_other TEXT') } catch { /* present */ }
  try { db.sqlite.exec('ALTER TABLE users ADD COLUMN program TEXT') } catch { /* present */ }
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const ids = {
    older3Days: add(db, { date: D1, start: '09:00', end: '10:00', at: OLD }),           // submitted ~100 days ago, date still in the future
    startPassedLongAgo: add(db, { date: pastDate(), start: '09:00', end: '10:00', at: OLD, lab: 11 }),
    startedEarlierToday: add(db, { date: today, start: '00:00', end: '00:30', at: '2026-11-01 08:00:00', lab: 11 }),
    submittedJustNow: add(db, { date: D2, start: '09:00', end: '10:00', at: new Date().toISOString().slice(0, 19).replace('T', ' '), lab: 11 }),
  }
  for (let i = 0; i < 3; i++) { const r = await listAs(c, MIS); assert.equal(r.code, 200, JSON.stringify(r.body)) } // repeated list loads = repeated "sweeps"
  for (const [k, id] of Object.entries(ids)) { const x = row(db, id); assert.equal(x.status, 'PENDING', k); assert.equal(x.decided_at, null, k); assert.equal(x.decision_note, null, k); assert.equal(x.decided_by, null, k) }
})
test('the unrelated APPROVED -> COMPLETED housekeeping on list load still works (only PENDING expiry was removed)', async () => {
  const { db, c } = setup()
  try { db.sqlite.exec('ALTER TABLE users ADD COLUMN role_other TEXT') } catch { /* present */ }
  try { db.sqlite.exec('ALTER TABLE users ADD COLUMN program TEXT') } catch { /* present */ }
  const done = add(db, { date: pastDate(), start: '09:00', end: '10:00', status: 'APPROVED', at: OLD }), pend = add(db, { date: pastDate(), start: '09:00', end: '10:00', at: OLD, lab: 11 })
  assert.equal((await listAs(c, MIS)).code, 200); assert.equal(row(db, done).status, 'COMPLETED'); assert.equal(row(db, pend).status, 'PENDING')
})
test('an old PENDING reservation whose start time has passed can still be decided MANUALLY by MIS / MIS Staff (decline, and approve)', async () => {
  const { db, c, audit } = setup()
  const a = add(db, { date: pastDate(), start: '09:00', end: '10:00', at: OLD }), b = add(db, { date: pastDate(), start: '13:00', end: '14:00', at: OLD })
  const declined = await decide(c, a, 'DECLINED', MIS, 'Manual decision'); assert.equal(declined.code, 200, JSON.stringify(declined.body))
  assert.equal(row(db, a).status, 'DECLINED'); assert.equal(row(db, a).decided_by, 1); assert.equal(row(db, a).decision_note, 'Manual decision')
  const approved = await decide(c, b, 'APPROVED', STAFF); assert.equal(approved.code, 200, JSON.stringify(approved.body)); assert.equal(row(db, b).status, 'APPROVED'); assert.equal(row(db, b).decided_by, 2)
  assert.ok(audit.some(x => x[1] === 'RESERVATION DECLINED')); assert.ok(audit.some(x => x[1] === 'RESERVATION APPROVED'))
})
test('creating a reservation does not expire others: an old PENDING stays PENDING after new requests are submitted (CP105A overlapping PENDING still accepted)', async () => {
  const { db, c } = setup()
  const old = add(db, { date: D1, start: '09:00', end: '11:00', at: OLD })
  const submit = (userId, start_time, end_time) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.createReservation({ user: { id: userId, role: 'Teacher' }, body: { laboratory_id: 10, reservation_date: D1, start_time, end_time, purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Prof' } }, r) })
  const r1 = await submit(5, '10:00', '12:00'); assert.equal(r1.code, 201, JSON.stringify(r1.body)); assert.equal(r1.body.reservation.status, 'PENDING')
  assert.equal((await submit(4, '09:30', '10:30')).code, 201)
  assert.equal(row(db, old).status, 'PENDING')
})
test('CP105B/C still work end to end: later overlapping request is refused, earliest approved, the other overlapping PENDING is auto-cancelled with audit', async () => {
  const { db, c, audit } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: OLD }), later = add(db, { start: '10:00', end: '12:00', at: '2026-11-01 08:00:01', by: 5 })
  assert.equal((await decide(c, later, 'APPROVED')).code, 409)
  assert.equal((await decide(c, first, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, [first, later]), ['APPROVED', 'CANCELLED'])
  assert.ok(audit.some(a => a[1] === 'RESERVATION AUTO-CANCELLED')); assert.match(row(db, later).cancellation_note, /^Automatically cancelled:/)
})
test('no automatic PENDING expiry code remains in the server: no timer, no sweep, no expiry SQL/config', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (['node_modules', 'test'].includes(e.name) ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : [])
  const files = walk(path.resolve(__dirname, '..'))
  const banned = /startPendingReservationExpiry|stopPendingReservationExpiry|declineExpiredPendingReservations|EXPIRE_SQL|EXPIRE_PARAMS|PENDING_EXPIRY_DAYS|CLMS_PENDING_EXPIRY_DAYS|AUTO_DECLINE_NOTE_(SUBMISSION|START)/
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), banned, path.relative(path.resolve(__dirname, '..'), f))
  assert.doesNotMatch(read('server.js'), /setInterval|pendingReservationExpiry/)
  const X = require('../utils/pendingReservationExpiry.js'); assert.deepEqual(Object.keys(X).sort(), ['AUTO_CANCEL_NOTE_PREFIX', 'AUTO_DECLINE_NOTE_PREFIX', 'RESTORE_BLOCKED_NOTE_PREFIX', 'isAutoCancelledNote', 'isAutoDeclinedNote'])
  assert.equal(X.isAutoCancelledNote('Automatically cancelled: x'), true); assert.equal(X.isAutoDeclinedNote('Automatically declined: x'), true); assert.equal(X.isAutoCancelledNote('Manual'), false)
})
test('the only automatic status changes left in the controller are APPROVED->COMPLETED (list load) and the CP105B overlap cancellation after a manual decision', () => {
  const ctl = read('controllers', 'reservationController.js')
  assert.match(ctl, /SET status = 'COMPLETED'\s+WHERE status = 'APPROVED'/); assert.doesNotMatch(ctl, /SET status = 'DECLINED'/); assert.match(ctl, /SET status = 'CANCELLED', cancellation_note = \?, cancelled_at = NOW\(\), cancelled_by = \? WHERE id IN/)
})
test('slots: PENDING and APPROVED are still listed as blocking statuses for approval/undo checks; DECLINED and CANCELLED release; back-to-back is allowed (real controller predicates)', () => {
  const { DatabaseSync } = require('node:sqlite')
  const { BLOCKING_STATUS_SQL, OVERLAP_SQL } = require('../controllers/reservationController.js')
  assert.match(BLOCKING_STATUS_SQL, /PENDING/); assert.match(BLOCKING_STATUS_SQL, /APPROVED/); assert.doesNotMatch(BLOCKING_STATUS_SQL, /DECLINED|CANCELLED/)
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('CREATE TABLE r (status TEXT, start_time TEXT, end_time TEXT)')
  const blocks = (status, s, e, ns, ne) => { sqlite.exec('DELETE FROM r'); sqlite.prepare('INSERT INTO r VALUES (?,?,?)').run(status, s, e); return sqlite.prepare(`SELECT 1 FROM r WHERE status IN (${BLOCKING_STATUS_SQL}) AND ${OVERLAP_SQL}`).all(ne, ns).length > 0 }
  assert.equal(blocks('APPROVED', '09:00:00', '11:00:00', '10:00:00', '12:00:00'), true); assert.equal(blocks('DECLINED', '09:00:00', '11:00:00', '10:00:00', '12:00:00'), false)
  assert.equal(blocks('APPROVED', '09:00:00', '11:00:00', '11:00:00', '12:00:00'), false, 'back-to-back (11:00 end / 11:00 start) is allowed')
})
