'use strict'
// CP165 Part 2: MIS Head approval/decline order for overlapping PENDING reservations (first come, first served).
// The ordering rule itself (created_at ASC, id ASC; a later overlapping PENDING cannot be approved or declined first) already exists in
// decideReservation (CP105C) and is unit-tested in reservationEarliestFirstCp105C.test.js. This file checks it END TO END with requests
// created through the real createReservation (the Part 1 submission rules) so created_at comes from the database default, including the
// same-second case that makes the id tie-breaker matter.
// TEST TYPE: REAL controllers + real SQL against an in-memory SQLITE database (NOT MySQL/MariaDB). MySQL row locks / NOW() are NOT exercised.
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

const submitReq = (c, user, start, end, lab = 10, date = D1) => new Promise(resolve => { const r = res(); const j = r.json.bind(r); r.json = b => { j(b); resolve(r); return r }; c.createReservation({ user, body: { laboratory_id: lab, reservation_date: date, start_time: start, end_time: end, purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Prof. Cruz' } }, r) })
const T4 = { id: 4, role: 'Teacher' }, T5 = { id: 5, role: 'Teacher' }
function world() { return setup() }

test('E2E: overlapping requests submitted via createReservation are decided strictly in submission order (same-second ties -> id)', async () => {
  const { db, c, audit } = world()
  const a = await submitReq(c, T4, '09:00', '11:00'), b = await submitReq(c, T5, '10:00', '12:00'), d = await submitReq(c, T4, '09:30', '10:30')
  for (const r of [a, b, d]) assert.equal(r.code, 201, JSON.stringify(r.body)) // Part 1: overlapping PENDING requests are all accepted
  const [A, B, C] = [a, b, d].map(r => r.body.reservation.id)
  assert.deepEqual([A, B, C].map(id => row(db, id).created_at !== null), [true, true, true], 'created_at comes from the database')
  const before = snapshot(db), auditBefore = audit.length
  for (const [id, decision, note] of [[B, 'APPROVED'], [B, 'DECLINED', 'No'], [C, 'APPROVED'], [C, 'DECLINED', 'No']]) {
    const r = await decide(c, id, decision, MIS, note); assert.equal(r.code, 409, `${id} ${decision}`); assert.match(r.body.message, new RegExp(`earlier overlapping reservation \\(#${A}\\)`))
  }
  assert.equal(snapshot(db), before, 'refused decisions change nothing'); assert.equal(audit.length, auditBefore, 'and write no audit entry')
  const ok = await decide(c, A, 'APPROVED'); assert.equal(ok.code, 200, JSON.stringify(ok.body)); assert.deepEqual(ok.body.auto_cancelled_ids.sort(), [B, C].sort())
  assert.deepEqual(statuses(db, [A, B, C]), ['APPROVED', 'CANCELLED', 'CANCELLED'])
  assert.equal((await decide(c, B, 'APPROVED')).code, 409, 'a cancelled request can no longer be decided')
  assert.equal((await submitReq(c, T5, '10:00', '11:00')).code, 409, 'Part 1: an APPROVED reservation still blocks a new overlapping request')
})

test('E2E: the order follows created_at, not id - an earlier-submitted request with a higher id goes first', async () => {
  const { db, c } = world()
  const x = (await submitReq(c, T4, '09:00', '11:00')).body.reservation.id, y = (await submitReq(c, T5, '10:00', '12:00')).body.reservation.id
  db.sqlite.prepare("UPDATE reservations SET created_at = '2026-11-01 08:00:01' WHERE id = ?").run(y)
  db.sqlite.prepare("UPDATE reservations SET created_at = '2026-11-01 08:00:09' WHERE id = ?").run(x)
  const refused = await decide(c, x, 'APPROVED'); assert.equal(refused.code, 409); assert.match(refused.body.message, new RegExp(`\\(#${y}\\)`))
  assert.equal((await decide(c, y, 'DECLINED', MIS, 'Lab reserved')).code, 200)
  assert.equal(row(db, y).status, 'DECLINED'); assert.equal(row(db, y).decided_by, 1)
})

test('E2E: requests that do not really overlap are not held back (back-to-back, other laboratory, other date)', async () => {
  const { db, c } = world()
  const p = (await submitReq(c, T4, '09:00', '10:00')).body.reservation.id
  const q = (await submitReq(c, T5, '10:00', '11:00')).body.reservation.id          // back-to-back with p
  const r = (await submitReq(c, T5, '09:00', '10:00', 11)).body.reservation.id       // same time, other laboratory
  const s = (await submitReq(c, T5, '09:00', '10:00', 10, D2)).body.reservation.id   // same time, other date
  for (const id of [q, r, s]) assert.equal((await decide(c, id, 'APPROVED')).code, 200, `#${id} decided while #${p} is still PENDING`)
  assert.equal(row(db, p).status, 'PENDING'); assert.deepEqual(statuses(db, [q, r, s]), ['APPROVED', 'APPROVED', 'APPROVED'])
})
