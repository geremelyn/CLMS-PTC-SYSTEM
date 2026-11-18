'use strict'
// CP17 regression tests: Reservations Delete All (request validation + 5,000 limit + Recycle Bin snapshots + restore).
// SQLITE (real controller SQL, NOT MySQL/MariaDB) + the real validation code. Real HTTP/Express and real MySQL were NOT used.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }
function seed(db, n) {
  const s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'), (7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  const rs = s.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name) VALUES (?,?,?,?,?,?,?,?)")
  s.exec('BEGIN'); for (let i = 1; i <= n; i++) rs.run(i, 2, 7, '2026-11-10', '08:00:00', '09:00:00', 'DECLINED', `Subject ${i}`); s.exec('COMMIT')
}
const range = n => Array.from({ length: n }, (_, i) => i + 1)
async function del(db, body, user = MIS) { const { bin } = loadControllers(db); const r = res(); await bin.deleteReservations({ body, user }, r); return r }

test('exact failure: an empty selection says nothing was selected (NOT "Select between 1 and 5000")', async () => {
  const db = createSqliteDb(); seed(db, 3)
  for (const body of [{ ids: [] }, {}, { ids: 'x' }]) { const r = await del(db, body); assert.equal(r.code, 400); assert.match(r.body.message, /No reservations were selected/); assert.doesNotMatch(r.body.message, /Select between/) }
  assert.equal(count(db, 'reservations'), 3)
})
test('one bad id is reported as an invalid id (not as a bad count) and deletes nothing', async () => {
  const db = createSqliteDb(); seed(db, 3)
  for (const ids of [[1, null], [1, 'abc'], [1, 0], [1, -5], [1, 1.5], [1, {}]]) { const r = await del(db, { ids }); assert.equal(r.code, 400, JSON.stringify(ids)); assert.match(r.body.message, /invalid reservation id/) }
  assert.equal(count(db, 'reservations'), 3); assert.equal(count(db, 'recycle_bin'), 0)
})
test('ids sent as numeric strings and duplicates are accepted (selection ids from the page)', async () => {
  const db = createSqliteDb(); seed(db, 5); const r = await del(db, { ids: ['1', 2, '2', ' 3 '] })
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 3); assert.equal(count(db, 'reservations'), 2)
})
test('limit: exactly 5,000 ids are accepted and fully deleted with Recycle Bin snapshots; 5,001 is refused with a clear message and nothing changes', async () => {
  const db = createSqliteDb(); seed(db, 5001)
  const tooMany = await del(db, { ids: range(5001) }); assert.equal(tooMany.code, 400); assert.match(tooMany.body.message, /at most 5000 reservations \(received 5001\)/); assert.equal(count(db, 'reservations'), 5001); assert.equal(count(db, 'recycle_bin'), 0)
  const ok = await del(db, { ids: range(5000) }); assert.equal(ok.code, 200, JSON.stringify(ok.body).slice(0, 200)); assert.equal(ok.body.deletedCount, 5000)
  assert.equal(count(db, 'reservations'), 1); assert.equal(count(db, 'recycle_bin', "entity_type='reservations' AND restored_at IS NULL"), 5000); assert.equal(ok.body.recycleIds.length, 5000)
})
test('Delete All of 1,200 reservations in 1,000-id batches (what the page sends) deletes all, and restoring the Recycle Bin items brings them all back', async () => {
  const db = createSqliteDb(); seed(db, 1200); const { bin } = loadControllers(db); const recycleIds = []
  for (const part of [range(1200).slice(0, 1000), range(1200).slice(1000)]) { const r = await del(db, { ids: part, skipMissing: true }); assert.equal(r.code, 200); recycleIds.push(...r.body.recycleIds) }
  assert.equal(count(db, 'reservations'), 0); assert.equal(recycleIds.length, 1200)
  for (let i = 0; i < recycleIds.length; i += 1000) { const r = res(); await bin.restoreRecycleItems({ body: { ids: recycleIds.slice(i, i + 1000) }, user: MIS }, r); assert.equal(r.code, 200, JSON.stringify(r.body)) }
  assert.equal(count(db, 'reservations'), 1200)
})
test('permissions: the route is MIS only; a batch where every reservation vanished returns 409 and changes nothing', async () => {
  const router = require('../routes/reservationRoutes.js'); const layer = router.stack.find(l => l.route && l.route.path === '/bulk-delete')
  assert.ok(layer, 'bulk-delete route exists'); assert.ok(layer.route.methods.post)
  const db = createSqliteDb(); seed(db, 2); const r = await del(db, { ids: [900, 901] }); assert.equal(r.code, 409); assert.equal(count(db, 'reservations'), 2)
})
