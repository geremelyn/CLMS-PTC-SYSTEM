'use strict'
// CP105C (Sir JC): the earliest submitted overlapping PENDING request must be decided first (created_at, then id). A later one is refused with 409
// and nothing changes; once the earliest is decided, CP105B cancels the other overlapping PENDING requests.
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
function add(db, { lab = 10, date = D1, start, end, status = 'PENDING', by = 4, at = '2026-11-01 08:00:00', id: fixedId }) {
  const id = fixedId ?? nextId++
  db.sqlite.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name, purpose, professor_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, lab, by, date, start + ':00', end + ':00', status, 'S', 'P', 'Prof', at)
  return id
}
const row = (db, id) => db.sqlite.prepare('SELECT * FROM reservations WHERE id = ?').get(id)
const statuses = (db, ids) => ids.map(i => row(db, i).status)
const decide = (c, id, decision, user = MIS, note) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.decideReservation({ params: { id: String(id) }, body: { decision, decision_note: note }, user }, r) })


const T = n => `2026-11-01 08:00:${String(n).padStart(2, '0')}` // T(1) is earlier than T(2)
const snapshot = (db) => JSON.stringify(db.sqlite.prepare('SELECT * FROM reservations ORDER BY id').all())

test('a LATER overlapping request cannot be approved or declined first: 409, clear message, nothing changed, no audit', async () => {
  const { db, c, audit } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: T(1), by: 4 }), later = add(db, { start: '10:00', end: '12:00', at: T(2), by: 5 })
  const before = snapshot(db)
  for (const [d, n] of [['APPROVED'], ['DECLINED', 'No']]) {
    const r = await decide(c, later, d, MIS, n); assert.equal(r.code, 409, d); assert.match(r.body.message, new RegExp(`earlier overlapping reservation \\(#${first}\\).*first`))
  }
  assert.equal(snapshot(db), before, 'neither reservation changed'); assert.equal(audit.length, 0)
})
test('the EARLIEST request can be approved; the later overlapping one is then auto-cancelled (CP105B) and cannot be decided', async () => {
  const { db, c } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: T(1) }), later = add(db, { start: '10:00', end: '12:00', at: T(2), by: 5 })
  const r = await decide(c, first, 'APPROVED'); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.auto_cancelled_ids, [later])
  assert.deepEqual(statuses(db, [first, later]), ['APPROVED', 'CANCELLED']); assert.equal((await decide(c, later, 'APPROVED')).code, 409)
})
test('the EARLIEST request can be declined; the later overlapping one is auto-cancelled', async () => {
  const { db, c, audit } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: T(1) }), later = add(db, { start: '10:30', end: '12:00', at: T(2), by: 5 })
  assert.equal((await decide(c, first, 'DECLINED', MIS, 'Lab busy')).code, 200)
  assert.deepEqual(statuses(db, [first, later]), ['DECLINED', 'CANCELLED']); assert.ok(audit.some(a => a[1] === 'RESERVATION AUTO-CANCELLED'))
})
test('ORDER is by created_at, not by id: a lower id submitted later is refused, the higher id submitted earlier goes first', async () => {
  const { db, c } = setup()
  const lowIdLate = add(db, { id: 1, start: '09:00', end: '11:00', at: T(9) }), highIdEarly = add(db, { id: 2, start: '10:00', end: '12:00', at: T(1), by: 5 })
  assert.equal((await decide(c, lowIdLate, 'APPROVED')).code, 409); assert.deepEqual(statuses(db, [lowIdLate, highIdEarly]), ['PENDING', 'PENDING'])
  assert.equal((await decide(c, highIdEarly, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, [lowIdLate, highIdEarly]), ['CANCELLED', 'APPROVED'])
})
test('identical created_at: the smaller id is the earlier request (stable tie-breaker)', async () => {
  const { db, c } = setup()
  const a = add(db, { id: 1, start: '09:00', end: '11:00', at: T(5) }), b = add(db, { id: 2, start: '09:30', end: '10:30', at: T(5), by: 5 }), cc = add(db, { id: 3, start: '10:00', end: '11:00', at: T(5) })
  assert.equal((await decide(c, b, 'APPROVED')).code, 409); assert.equal((await decide(c, cc, 'APPROVED')).code, 409)
  assert.equal((await decide(c, a, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, [a, b, cc]), ['APPROVED', 'CANCELLED', 'CANCELLED'])
})
test('three overlapping requests must be decided strictly in submission order', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '12:00', at: T(1) }), b = add(db, { start: '09:30', end: '10:30', at: T(2), by: 5 }), cc = add(db, { start: '10:00', end: '11:00', at: T(3) })
  assert.equal((await decide(c, cc, 'DECLINED', MIS, 'x')).code, 409); assert.equal((await decide(c, b, 'APPROVED')).code, 409)
  assert.deepEqual(statuses(db, [a, b, cc]), ['PENDING', 'PENDING', 'PENDING'])
  assert.equal((await decide(c, a, 'DECLINED', MIS, 'x')).code, 200); assert.deepEqual(statuses(db, [a, b, cc]), ['DECLINED', 'CANCELLED', 'CANCELLED'])
})
test('chain: an earlier PENDING that overlaps only part of the group still blocks, until it is decided or cancelled', async () => {
  const { db, c } = setup()
  const a = add(db, { start: '09:00', end: '10:00', at: T(1) }), b = add(db, { start: '09:30', end: '10:30', at: T(2) }), cc = add(db, { start: '10:15', end: '11:00', at: T(3) }) // cc overlaps only b
  assert.equal((await decide(c, cc, 'APPROVED')).code, 409, 'b is earlier and overlaps cc'); assert.equal((await decide(c, b, 'APPROVED')).code, 409, 'a is earlier and overlaps b')
  assert.equal((await decide(c, a, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, [a, b, cc]), ['APPROVED', 'CANCELLED', 'PENDING'])
  assert.equal((await decide(c, cc, 'APPROVED')).code, 200, 'b is cancelled now, so cc is the earliest remaining'); assert.equal(row(db, cc).status, 'APPROVED')
})
test('NOT affected: non-overlapping, back-to-back, other date, other laboratory - a later request there is decidable even with earlier PENDING requests elsewhere', async () => {
  const { db, c } = setup()
  const early = add(db, { start: '09:00', end: '11:00', at: T(1) })
  const cases = { backToBackAfter: { start: '11:00', end: '12:00' }, backToBackBefore: { start: '08:00', end: '09:00' }, far: { start: '14:00', end: '15:00' }, otherDate: { start: '09:00', end: '11:00', date: D2 }, otherLab: { start: '09:00', end: '11:00', lab: 11 } }
  const ids = {}; for (const [k, v] of Object.entries(cases)) ids[k] = add(db, { ...v, at: T(20) })
  for (const [k, id] of Object.entries(ids)) assert.equal((await decide(c, id, 'APPROVED')).code, 200, k)
  assert.equal(row(db, early).status, 'PENDING', 'the unrelated decisions did not touch the early request')
  assert.equal((await decide(c, early, 'APPROVED')).code, 200); assert.deepEqual(statuses(db, Object.values(ids)), Array(5).fill('APPROVED'))
})
test('earlier requests that are no longer PENDING (declined / cancelled) do not block; an earlier APPROVED one still blocks approval by the existing conflict rule', async () => {
  const { db, c } = setup()
  add(db, { start: '09:00', end: '11:00', at: T(1), status: 'DECLINED' }); add(db, { start: '09:00', end: '11:00', at: T(1), status: 'CANCELLED' })
  const ok = add(db, { start: '10:00', end: '12:00', at: T(5) }); assert.equal((await decide(c, ok, 'APPROVED')).code, 200)
  const blocked = add(db, { start: '11:00', end: '13:00', at: T(6), by: 5 }), another = add(db, { start: '11:30', end: '12:30', at: T(7) })
  const r = await decide(c, another, 'APPROVED'); assert.equal(r.code, 409); assert.match(r.body.message, /earlier overlapping/, 'blocked by the earlier PENDING one, not by the approved one')
  assert.equal((await decide(c, blocked, 'APPROVED')).code, 409); assert.match((await decide(c, blocked, 'APPROVED')).body.message, /Cannot approve: the time overlaps/)
  assert.equal((await decide(c, blocked, 'DECLINED', MIS, 'Overlaps approved')).code, 200); assert.equal(row(db, another).status, 'CANCELLED')
})
test('unauthorized roles stay blocked (403) and nothing changes; MIS Staff may decide the earliest request', async () => {
  const { db, c } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: T(1) }), later = add(db, { start: '10:00', end: '12:00', at: T(2), by: 5 }); const before = snapshot(db)
  for (const user of [TEACHER, { id: 3, role: 'Dean' }, { id: 6, role: 'Others' }, null]) for (const id of [first, later]) assert.equal((await decide(c, id, 'APPROVED', user)).code, 403)
  assert.equal(snapshot(db), before)
  assert.equal((await decide(c, later, 'APPROVED', STAFF)).code, 409); assert.equal((await decide(c, first, 'APPROVED', STAFF)).code, 200)
})
test('failed decisions do not partially update: failure in the earliest-first check, the decision UPDATE or the cancel UPDATE leaves everything PENDING', async () => {
  for (const pattern of [/^SELECT id FROM reservations WHERE laboratory_id = \? AND reservation_date = \? AND id <> \? AND status = 'PENDING' AND start_time < \? AND end_time > \? AND \(created_at/, /^UPDATE reservations SET status = \?, decision_note/, /^UPDATE reservations SET status = 'CANCELLED'/]) {
    const { db, c, audit } = setup({ failWhen: sql => pattern.test(sql) ? Object.assign(new Error('simulated driver failure'), { code: 'ER_X' }) : null })
    const first = add(db, { start: '09:00', end: '11:00', at: T(1) }), later = add(db, { start: '10:00', end: '12:00', at: T(2), by: 5 }); const before = snapshot(db)
    const r = await decide(c, first, 'APPROVED'); assert.equal(r.code, 500, String(pattern)); assert.equal(snapshot(db), before); assert.equal(audit.length, 0)
  }
})
test('transaction/lock order: laboratory lock -> decided row lock -> earliest-first check (FOR UPDATE) -> decision UPDATE -> cancel -> COMMIT; refused decision rolls back', async () => {
  const { db, c } = setup()
  const first = add(db, { start: '09:00', end: '11:00', at: T(1) }), later = add(db, { start: '10:00', end: '12:00', at: T(2), by: 5 })
  assert.equal((await decide(c, later, 'APPROVED')).code, 409); assert.ok(!db.state.log.some(q => /^UPDATE reservations/.test(q)), 'no UPDATE was issued for the refused decision')
  db.state.log.length = 0; await decide(c, first, 'APPROVED'); const log = db.state.log, ix = re => log.findIndex(q => re.test(q))
  const order = [/FROM laboratories WHERE id = \? FOR UPDATE/, /FROM reservations WHERE id = \? FOR UPDATE/, /AND \(created_at < \? OR \(created_at = \? AND id < \?\)\) ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE/, /^UPDATE reservations SET status = \?, decision_note/, /^UPDATE reservations SET status = 'CANCELLED'/].map(ix)
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || order[i - 1] < v)), JSON.stringify(order))
})
test('CP105A submission rules are unchanged: overlapping PENDING requests can still be submitted (source check)', () => {
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '../controllers/reservationController.js'), 'utf8')
  assert.equal((src.match(/status IN \(\$\{NEW_REQUEST_BLOCKING_SQL\}\)/g) || []).length, 3); assert.ok(!require('../controllers/reservationController.js').NEW_REQUEST_BLOCKING_SQL.includes('PENDING'))
})
