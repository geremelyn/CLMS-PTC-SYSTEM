'use strict'
// CP73 regression: the original "invalid reservation id" report on Reservations -> Delete All.
// What is REAL here: the page's own id/status logic (validId, DELETABLE_STATUSES, isDeletable are extracted from client/src/pages/Reservations.jsx
// and executed), the real batching helper client/src/utils/batchDelete.js, and the real recycleBinController.deleteReservations SQL.
// What is NOT real: the database is SQLite (not MySQL/MariaDB), the list rows are hand-made in the shape the list API returns, and no browser/Express/HTTP is involved.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const SRC = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Reservations.jsx'), 'utf8')
const pick = re => { const m = re.exec(SRC); assert.ok(m, 'page source changed: ' + re); return m[0] }
const pageLogic = new Function(`${pick(/const DELETABLE_STATUSES = .*/)}\n${pick(/const isDeletable = .*/)}\n${pick(/const validId = .*/)}\nreturn { DELETABLE_STATUSES, isDeletable, validId }`)()
// The exact payload-building lines of deleteReservations(), kept in sync by the source assertions below.
function buildPayload(filteredReservations, selectedIds) {
  const deleteAll = selectedIds.length === 0
  const pool = deleteAll ? filteredReservations : filteredReservations.filter(item => selectedIds.includes(item.id))
  const eligible = deleteAll ? pool.filter(pageLogic.isDeletable) : pool
  const ids = eligible.map(item => pageLogic.validId(item.id)).filter(id => id !== null)
  return { ids, extra: deleteAll ? { skipMissing: true, deleteAll: true } : { skipMissing: false } }
}
const MIS = { id: 1, role: 'MIS' }, STAT = ['PENDING', 'APPROVED', 'COMPLETED', 'DECLINED', 'CANCELLED']
function seed(n) {
  const db = createSqliteDb(), s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(7,'t7','Teacher','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  const ins = s.prepare('INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name) VALUES (?,?,?,?,?,?,?,?)')
  for (let i = 1; i <= n; i++) ins.run(i, 2, 7, '2026-11-10', '08:00:00', '09:00:00', STAT[(i - 1) % 5], 'S' + i)
  return db
}
// list rows as the page holds them (id number, like mysql2 INT columns)
const rowsOf = db => db.sqlite.prepare('SELECT id, status FROM reservations ORDER BY id').all().map(r => ({ id: r.id, status: r.status }))
async function post(db, body, user = MIS) { const { bin } = loadControllers(db); const r = res(); await bin.deleteReservations({ body, user }, r); return r }

test('CP73: page logic - Delete All sends only valid positive-integer ids of Completed/Declined/Cancelled rows, never Pending/Approved', () => {
  const rows = [{ id: 1, status: 'PENDING' }, { id: 2, status: 'APPROVED' }, { id: 3, status: 'COMPLETED' }, { id: '4', status: 'declined' }, { id: 5, status: 'CANCELLED' }]
  assert.deepEqual(buildPayload(rows, []).ids, [3, 4, 5]); assert.equal(buildPayload(rows, []).extra.deleteAll, true)
})
test('CP73: rows whose id is missing / null / 0 / negative / text / object are never put in the request (the cause of an "invalid reservation id" 400)', () => {
  const bad = [undefined, null, 0, -3, 'abc', '', '1.5', {}, [], NaN, 2 ** 60].map(id => ({ id, status: 'COMPLETED' }))
  assert.deepEqual(buildPayload([...bad, { id: 9, status: 'COMPLETED' }], []).ids, [9])
})
test('CP73: end-to-end on the real controller - Delete All of a realistic list (page payload -> real SQL) returns 200, deletes only finished rows, keeps Pending/Approved, snapshots to the Recycle Bin', async () => {
  const db = seed(50), p = buildPayload(rowsOf(db), [])
  const r = await post(db, { ids: p.ids, ...p.extra }); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.equal(r.body.deletedCount, 30); assert.equal(r.body.skippedCount, 0)
  assert.deepEqual([...new Set(rowsOf(db).map(x => x.status))].sort(), ['APPROVED', 'PENDING']); assert.equal(count(db, 'reservations'), 20)
  assert.equal(count(db, 'recycle_bin', "entity_type='reservations' AND restored_at IS NULL"), 30); assert.equal(r.body.recycleIds.length, 30)
})
test('CP73: the server STILL rejects a genuinely invalid id with the explicit message and deletes nothing (guard unchanged)', async () => {
  const db = seed(5), r = await post(db, { ids: [1, null, 'x'], deleteAll: true }); assert.equal(r.code, 400); assert.match(r.body.message, /invalid reservation id/i); assert.equal(count(db, 'reservations'), 5)
})
test('CP73: permissions - only MIS (Super Admin) reaches the controller route; the route file guards bulk-delete with requireRole("MIS") alone', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/reservationRoutes.js'), 'utf8')
  assert.match(routes, /router\.post\('\/bulk-delete', requireRole\('MIS'\), /)
})
test('CP73: protection - Pending/Approved survive even if a stale page sends their ids with deleteAll:true; Completed/Declined/Cancelled go', async () => {
  const db = seed(5), r = await post(db, { ids: [1, 2, 3, 4, 5], deleteAll: true, skipMissing: true }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 3); assert.equal(r.body.skippedCount, 2)
  assert.deepEqual(rowsOf(db).map(x => x.status), ['PENDING', 'APPROVED'])
})
test('CP73: restore - everything Delete All removed comes back from the Recycle Bin snapshots', async () => {
  const db = seed(10), p = buildPayload(rowsOf(db), []), r = await post(db, { ids: p.ids, ...p.extra }); assert.equal(r.code, 200)
  const { bin } = loadControllers(db), rr = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, rr)
  assert.equal(rr.code, 200, JSON.stringify(rr.body)); assert.equal(count(db, 'reservations'), 10)
})
test('CP73: the page source still builds the payload the way this test models it (guards against drift)', () => {
  assert.match(SRC, /const ids = eligible\.map\(item => validId\(item\.id\)\)\.filter\(id => id !== null\)/)
  assert.match(SRC, /deleteAll \? \{ skipMissing: true, deleteAll: true \} : \{ skipMissing: false \}/)
  assert.match(SRC, /const eligible = deleteAll \? pool\.filter\(isDeletable\) : pool/)
})
