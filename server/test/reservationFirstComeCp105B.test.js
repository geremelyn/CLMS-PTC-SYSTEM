'use strict'
// CP105B (Sir JC): first-come, first-served decision. When MIS approves or declines a PENDING reservation, every OTHER still-PENDING
// reservation that overlaps it (same laboratory + date) is CANCELLED in the same transaction.
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
  for (const sql of ['ALTER TABLE reservations ADD COLUMN professor_name TEXT', 'ALTER TABLE reservations ADD COLUMN decision_note TEXT', 'ALTER TABLE reservations ADD COLUMN decided_at TEXT', 'ALTER TABLE reservations ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP', 'ALTER TABLE reservations ADD COLUMN cancellation_note TEXT', 'ALTER TABLE reservations ADD COLUMN cancelled_at TEXT', 'ALTER TABLE laboratories ADD COLUMN booking_interval INTEGER']) { try { s.exec(sql) } catch { /* already in adapter schema */ } }
  s.exec(`INSERT INTO users (id, username, full_name, role, status) VALUES (1,'mis','Super Admin','MIS','ACTIVE'),(2,'staff','MIS Staff','Inventory Staff','ACTIVE'),(3,'dean','Dean D','Dean','ACTIVE'),(4,'teach','Teacher T','Teacher','ACTIVE'),(5,'teach2','Teacher Two','Teacher','ACTIVE')`)
  s.exec(`INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (10,'Lab 10',40,'OPEN'),(11,'Lab 11',40,'OPEN')`)
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit(...a) { audit.push(a) } })
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  return { db, audit, c: require('../controllers/reservationController.js') }
}
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 2, role: 'Inventory Staff' }, TEACHER = { id: 4, role: 'Teacher' }
let nextId = 1
function add(db, { lab = 10, date = D1, start, end, status = 'PENDING', by = 4 }) {
  const id = nextId++
  db.sqlite.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name, purpose, professor_name) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, lab, by, date, start + ':00', end + ':00', status, 'S', 'P', 'Prof')
  return id
}
const row = (db, id) => db.sqlite.prepare('SELECT * FROM reservations WHERE id = ?').get(id)
const statuses = (db, ids) => ids.map(i => row(db, i).status)
const decide = (c, id, decision, user = MIS, note) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.decideReservation({ params: { id: String(id) }, body: { decision, decision_note: note }, user }, r) })

test('APPROVE the earliest request: it stays APPROVED, every overlapping PENDING is CANCELLED (same teacher and others)', async () => {
  const { db, c, audit } = setup()
  const first = add(db, { start: '09:00', end: '11:00', by: 4 }), second = add(db, { start: '10:00', end: '12:00', by: 5 }), third = add(db, { start: '08:00', end: '09:30', by: 4 }), same = add(db, { start: '09:00', end: '11:00', by: 4 })
  const r = await decide(c, first, 'APPROVED'); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.deepEqual(statuses(db, [first, second, third, same]), ['APPROVED', 'CANCELLED', 'CANCELLED', 'CANCELLED'])
  assert.deepEqual(r.body.auto_cancelled_ids.sort(), [second, third, same].sort())
  const lost = row(db, second); assert.match(lost.cancellation_note, /^Automatically cancelled: .*#\d+.*approved first/); assert.equal(lost.cancelled_by, 1); assert.ok(lost.cancelled_at)
  assert.equal(row(db, first).decided_by, 1); assert.equal(row(db, first).cancellation_note, null)
  // audit logging: the decision itself plus one entry per auto-cancelled reservation
  assert.ok(audit.some(a => a[0] === 1 && a[1] === 'RESERVATION APPROVED' && a[2].includes(`#${first}`)))
  assert.equal(audit.filter(a => a[1] === 'RESERVATION AUTO-CANCELLED').length, 3)
})
test('DECLINE the earliest request: it stays DECLINED (with its reason) and the overlapping PENDING are CANCELLED too', async () => {
  const { db, c, audit } = setup()
  const first = add(db, { start: '09:00', end: '11:00' }), second = add(db, { start: '10:30', end: '12:00', by: 5 })
  assert.equal((await decide(c, first, 'DECLINED', MIS)).code, 400, 'a decline still needs a reason (unchanged validation)')
  const r = await decide(c, first, 'DECLINED', MIS, 'Lab under repair'); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.deepEqual(statuses(db, [first, second]), ['DECLINED', 'CANCELLED']); assert.equal(row(db, first).decision_note, 'Lab under repair')
  assert.match(row(db, second).cancellation_note, /declined first/)
  assert.ok(audit.some(a => a[1] === 'RESERVATION DECLINED')); assert.ok(audit.some(a => a[1] === 'RESERVATION AUTO-CANCELLED'))
})
test('MIS Staff may decide as before and the cascade applies; Teacher / Dean / Others are still refused (403) and nothing changes', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '10:00' }), b = add(db, { start: '09:30', end: '10:30', by: 5 })
  for (const user of [TEACHER, { id: 3, role: 'Dean' }, { id: 6, role: 'Others' }]) assert.equal((await decide(c, a, 'APPROVED', user)).code, 403)
  assert.deepEqual(statuses(db, [a, b]), ['PENDING', 'PENDING'])
  assert.equal((await decide(c, a, 'APPROVED', STAFF)).code, 200); assert.deepEqual(statuses(db, [a, b]), ['APPROVED', 'CANCELLED'])
})
test('multiple overlapping requests chain correctly: only those overlapping the DECIDED one are cancelled, the rest stay PENDING', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '10:00' }), b = add(db, { start: '09:30', end: '10:30' }), cc = add(db, { start: '10:15', end: '11:00' }) // cc overlaps b but NOT a
  assert.equal((await decide(c, a, 'APPROVED')).code, 200)
  assert.deepEqual(statuses(db, [a, b, cc]), ['APPROVED', 'CANCELLED', 'PENDING'])
  assert.equal((await decide(c, cc, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, [a, b, cc]), ['APPROVED', 'CANCELLED', 'APPROVED'])
})
test('NOT cancelled: non-overlapping, back-to-back, another date, another laboratory; also not already APPROVED/DECLINED/CANCELLED/COMPLETED rows', async () => {
  const { db, c } = setup()
  const main = add(db, { start: '09:00', end: '11:00' })
  const before = add(db, { start: '08:00', end: '09:00' }), after = add(db, { start: '11:00', end: '12:00' }), far = add(db, { start: '14:00', end: '15:00' })
  const otherDate = add(db, { start: '09:00', end: '11:00', date: D2 }), otherLab = add(db, { start: '09:00', end: '11:00', lab: 11 })
  const approved = add(db, { start: '09:00', end: '10:00', status: 'APPROVED' }), declined = add(db, { start: '09:00', end: '10:00', status: 'DECLINED' }), cancelled = add(db, { start: '09:00', end: '10:00', status: 'CANCELLED' }), completed = add(db, { start: '09:00', end: '10:00', status: 'COMPLETED' })
  // an APPROVED reservation already overlaps -> approving is still refused (existing rule), nothing cascades
  assert.equal((await decide(c, main, 'APPROVED')).code, 409)
  assert.equal(row(db, main).status, 'PENDING'); assert.deepEqual(statuses(db, [before, after, far, otherDate, otherLab]), Array(5).fill('PENDING'))
  // decline is allowed even then; it must only touch overlapping PENDING rows
  assert.equal((await decide(c, main, 'DECLINED', MIS, 'No')).code, 200)
  assert.deepEqual(statuses(db, [before, after, far, otherDate, otherLab]), Array(5).fill('PENDING'), 'back-to-back / far / other date / other lab untouched')
  assert.deepEqual(statuses(db, [approved, declined, cancelled, completed]), ['APPROVED', 'DECLINED', 'CANCELLED', 'COMPLETED'])
})
test('back-to-back requests are both approvable; neither cancels the other', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '08:00', end: '10:00' }), b = add(db, { start: '10:00', end: '12:00' })
  assert.equal((await decide(c, a, 'APPROVED')).code, 200); assert.equal((await decide(c, b, 'APPROVED')).code, 200)
  assert.deepEqual(statuses(db, [a, b]), ['APPROVED', 'APPROVED'])
})
test('repeated / late decisions: deciding the same request again, or an auto-cancelled one, is refused (409) and changes nothing', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '11:00' }), b = add(db, { start: '10:00', end: '12:00', by: 5 })
  assert.equal((await decide(c, a, 'APPROVED')).code, 200)
  const again = await decide(c, a, 'APPROVED'); assert.equal(again.code, 409); assert.match(again.body.message, /Only pending/)
  const flip = await decide(c, a, 'DECLINED', MIS, 'x'); assert.equal(flip.code, 409)
  for (const d of ['APPROVED', 'DECLINED']) assert.equal((await decide(c, b, d, MIS, 'x')).code, 409, 'auto-cancelled request cannot be decided')
  assert.deepEqual(statuses(db, [a, b]), ['APPROVED', 'CANCELLED']); assert.equal(row(db, b).cancelled_by, 1)
})
test('an auto-cancelled request is marked non-restorable: its note is recognised by the existing "Automatically cancelled reservations cannot be restored" guard', async () => {
  const { db, c } = setup(); const { isAutoCancelledNote } = require('../utils/pendingReservationExpiry.js')
  const a = add(db, { start: '09:00', end: '11:00' }), b = add(db, { start: '10:00', end: '12:00', by: 5 })
  await decide(c, a, 'APPROVED')
  assert.equal(isAutoCancelledNote(row(db, b).cancellation_note), true)
  // (undoCancelReservation itself uses MySQL-only SQL that the SQLite adapter cannot run, so the guard is checked at its source line instead.)
  assert.match(require('node:fs').readFileSync(path.resolve(__dirname, '../controllers/reservationController.js'), 'utf8'), /if \(isAutoCancelledNote\(reservation\.cancellation_note\)\) throw/)
})
test('atomic: if cancelling the overlapping requests fails, NOTHING is saved (decision rolled back, all stay PENDING)', async () => {
  const { db, c, audit } = setup({ failWhen: sql => /^UPDATE reservations SET status = 'CANCELLED'/.test(sql) ? Object.assign(new Error('simulated driver failure'), { code: 'ER_X' }) : null })
  const a = add(db, { start: '09:00', end: '11:00' }), b = add(db, { start: '10:00', end: '12:00', by: 5 })
  const r = await decide(c, a, 'APPROVED'); assert.equal(r.code, 500)
  assert.deepEqual(statuses(db, [a, b]), ['PENDING', 'PENDING']); assert.equal(row(db, a).decided_by, null); assert.equal(audit.length, 0, 'no audit entry for a rolled-back decision')
})
test('lock/transaction order: laboratory row locked before the reservation, cascade runs before COMMIT, FOR UPDATE on the overlapping rows', async () => {
  const { db, c } = setup(); const a = add(db, { start: '09:00', end: '11:00' }); add(db, { start: '10:00', end: '12:00' })
  await decide(c, a, 'APPROVED'); const log = db.state.log
  const ix = re => log.findIndex(q => re.test(q))
  assert.ok(ix(/FROM laboratories WHERE id = \? FOR UPDATE/) < ix(/FROM reservations WHERE id = \? FOR UPDATE/) && ix(/^UPDATE reservations SET status = \?, decision_note/) < ix(/AND status = 'PENDING' AND start_time < \? AND end_time > \? FOR UPDATE/) && ix(/AND status = 'PENDING' AND start_time < \? AND end_time > \? FOR UPDATE/) < ix(/^UPDATE reservations SET status = 'CANCELLED'/))
})
test('regression: approval now ignores overlapping PENDING (CP105A) but still refuses an overlapping APPROVED/COMPLETED reservation (409, no change)', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '11:00' }), done = add(db, { start: '10:00', end: '11:00', status: 'COMPLETED' })
  assert.equal((await decide(c, a, 'APPROVED')).code, 409); assert.equal(row(db, a).status, 'PENDING'); assert.equal(row(db, done).status, 'COMPLETED')
})
