'use strict'
// SQLITE tests for Recycle Bin PERMANENT DELETE (CP28). The REAL controller SQL runs against an in-memory SQLite database
// (real transactions + rollback). These are NOT MySQL/MariaDB tests: row locking and engine-specific errors are only simulated.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }
function seed(db, { computers = 0, reservations = 0 } = {}) {
  const s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'), (7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  const pc = s.prepare("INSERT INTO computers (id, computer_name, laboratory_id, asset_tag, serial_number, operational_status, \"condition\") VALUES (?,?,?,?,?,?,?)")
  for (let i = 1; i <= computers; i++) pc.run(i, `PC-${i}`, 2, `TAG-${i}`, `SN-${i}`, 'ACTIVE', 'WORKING')
  const rs = s.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name) VALUES (?,?,?,?,?,?,?,?)")
  for (let i = 1; i <= reservations; i++) rs.run(i, 2, 7, '2026-11-10', '08:00:00', '12:00:00', 'DECLINED', `Subject ${i}`)
}
const binIds = (db, where = "restored_at IS NULL") => db.sqlite.prepare(`SELECT id FROM recycle_bin WHERE ${where} ORDER BY id`).all().map(r => r.id)
const perm = async (bin, ids, user = MIS) => { const r = res(); await bin.permanentDeleteRecycleItems({ body: { ids }, user }, r); return r }

test('SQLite: permanently deleting SOME items removes only those recycle rows; others stay restorable; the old Undo can no longer bring the deleted ones back', async () => {
  const db = createSqliteDb(); seed(db, { computers: 5 }); const { bulk, bin } = loadControllers(db)
  const actions = bulk.createBulkRecordController('computers'), d = res(); await actions.bulkDelete({ body: { ids: [1, 2, 3, 4, 5] }, user: MIS }, d)
  assert.equal(d.code, 200); const all = binIds(db); assert.equal(all.length, 5)
  const r = await perm(bin, [all[0], all[1]]); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 2)
  assert.deepEqual(binIds(db), all.slice(2), 'the other 3 recycle rows are untouched')
  assert.equal(count(db, 'computers'), 0, 'permanent delete never re-creates or touches live computers')
  const snap = JSON.parse(db.sqlite.prepare('SELECT snapshot_json FROM undo_actions WHERE id = ?').get(d.body.undoActionId).snapshot_json)
  assert.deepEqual(snap.map(x => x.id), [3, 4, 5], 'the Undo snapshot lost the permanently deleted records')
  const u = res(); await actions.undoDelete({ params: { undoId: String(d.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.deepEqual(db.sqlite.prepare('SELECT id FROM computers ORDER BY id').all().map(x => x.id), [3, 4, 5], 'only the NOT deleted-for-good computers come back')
})

test('SQLite: permanently deleting EVERY record of an Undo snapshot retires that Undo (it cannot resurrect anything)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 3 }); const { bulk, bin } = loadControllers(db)
  const actions = bulk.createBulkRecordController('computers'), d = res(); await actions.bulkDelete({ body: { ids: [1, 2, 3] }, user: MIS }, d)
  const r = await perm(bin, binIds(db)); assert.equal(r.code, 200); assert.equal(count(db, 'recycle_bin'), 0)
  assert.ok(db.sqlite.prepare('SELECT used_at FROM undo_actions WHERE id = ?').get(d.body.undoActionId).used_at, 'undo action marked used')
  const u = res(); await actions.undoDelete({ params: { undoId: String(d.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 409); assert.equal(count(db, 'computers'), 0, 'nothing was resurrected')
})

test('SQLite: other, unrelated Undo actions and recycle rows are not touched', async () => {
  const db = createSqliteDb(); seed(db, { computers: 4 }); const { bulk, bin } = loadControllers(db); const actions = bulk.createBulkRecordController('computers')
  const a = res(), b = res(); await actions.bulkDelete({ body: { ids: [1, 2] }, user: MIS }, a); await actions.bulkDelete({ body: { ids: [3, 4] }, user: MIS }, b)
  const first = binIds(db).slice(0, 2); const r = await perm(bin, first); assert.equal(r.code, 200)
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT snapshot_json FROM undo_actions WHERE id = ?').get(b.body.undoActionId).snapshot_json).length, 2, 'second undo action untouched')
  assert.equal(db.sqlite.prepare('SELECT used_at FROM undo_actions WHERE id = ?').get(b.body.undoActionId).used_at, null)
  assert.equal(binIds(db).length, 2)
})

test('SQLite: reservations moved to the Recycle Bin are removed for good; nothing is re-inserted; restore is no longer possible', async () => {
  const db = createSqliteDb(); seed(db, { reservations: 10 }); const { bin } = loadControllers(db)
  const d = res(); await bin.deleteReservations({ body: { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, user: MIS }, d); assert.equal(d.code, 200, JSON.stringify(d.body)); assert.equal(count(db, 'reservations'), 0)
  const ids = binIds(db); assert.equal(ids.length, 10)
  const r = await perm(bin, ids); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 10)
  assert.equal(count(db, 'recycle_bin'), 0); assert.equal(count(db, 'reservations'), 0)
  const x = res(); await bin.restoreRecycleItems({ body: { ids }, user: MIS }, x); assert.equal(x.code, 404, 'restore after permanent delete: not found'); assert.equal(count(db, 'reservations'), 0)
})

test('SQLite: holiday items - the soft-deleted holiday row is deleted; an ACTIVE holiday is never deleted', async () => {
  const db = createSqliteDb(); const s = db.sqlite, { bin } = loadControllers(db)
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS')").run()
  const h = s.prepare("INSERT INTO holidays (id, holiday_date, name, holiday_type, is_active) VALUES (?,?,?,?,?)")
  h.run(50, '2026-12-25', 'Christmas Day', 'REGULAR', 0); h.run(51, '2026-12-30', 'Rizal Day', 'REGULAR', 1); h.run(52, '2026-12-31', 'Last Day', 'SPECIAL_NON_WORKING', 1)
  const b = s.prepare("INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ('holidays', ?, ?, '{}', 1)")
  b.run(50, 'Christmas Day'); b.run(52, 'Last Day (inconsistent: still active)')
  const r = await perm(bin, binIds(db)); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.equal(count(db, 'holidays', 'id = 50'), 0, 'soft-deleted holiday removed for good'); assert.equal(count(db, 'holidays', 'id = 51'), 1, 'unrelated active holiday untouched'); assert.equal(count(db, 'holidays', 'id = 52'), 1, 'an active holiday is never deleted')
  assert.equal(count(db, 'recycle_bin'), 0)
})

test('SQLite: all-or-nothing - an unknown id, or an already-restored item, makes the whole request a 409 and deletes NOTHING', async () => {
  const db = createSqliteDb(); seed(db, { computers: 3 }); const { bulk, bin } = loadControllers(db); const actions = bulk.createBulkRecordController('computers')
  await actions.bulkDelete({ body: { ids: [1, 2, 3] }, user: MIS }, res()); const ids = binIds(db)
  let r = await perm(bin, [...ids, 99999]); assert.equal(r.code, 409); assert.match(r.body.message, /Nothing was deleted/); assert.equal(count(db, 'recycle_bin'), 3)
  const rr = res(); await bin.restoreRecycleItem({ params: { id: String(ids[0]) }, user: MIS }, rr); assert.equal(rr.code, 200)
  r = await perm(bin, ids); assert.equal(r.code, 409); assert.match(r.body.message, /already restored/); assert.equal(count(db, 'recycle_bin'), 3, 'nothing removed'); assert.equal(count(db, 'computers'), 1, 'the restored computer is untouched')
})

test('SQLite: a database failure in the middle rolls EVERYTHING back (recycle rows and undo snapshots)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 4 }); const { bulk, bin } = loadControllers(db); const actions = bulk.createBulkRecordController('computers')
  const d = res(); await actions.bulkDelete({ body: { ids: [1, 2, 3, 4] }, user: MIS }, d); const ids = binIds(db)
  const undoBefore = db.sqlite.prepare('SELECT snapshot_json, used_at FROM undo_actions WHERE id = ?').get(d.body.undoActionId)
  db.state.failWhen = sql => sql.startsWith('DELETE FROM recycle_bin') ? Object.assign(new Error('Lost connection'), { code: 'PROTOCOL_CONNECTION_LOST' }) : null
  const r = await perm(bin, ids); db.state.failWhen = null
  assert.equal(r.code, 500); assert.match(r.body.message, /rolled back/); assert.equal(count(db, 'recycle_bin', 'restored_at IS NULL'), 4)
  assert.deepEqual(db.sqlite.prepare('SELECT snapshot_json, used_at FROM undo_actions WHERE id = ?').get(d.body.undoActionId), undoBefore, 'the undo snapshot pruning was rolled back too')
  assert.equal(r.body.deletedCount, undefined, 'no success payload on failure')
})

test('SQLite: large selection (1,200 recycle rows, several chunks) is deleted in one request; invalid and empty selections are refused without touching data', async () => {
  const db = createSqliteDb(); seed(db, { reservations: 1 }); const { bin } = loadControllers(db)
  const ins = db.sqlite.prepare("INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ('users', ?, ?, '{}', 1)")
  for (let i = 1; i <= 1200; i++) ins.run(1000 + i, `User ${i}`)
  const ids = binIds(db); assert.equal(ids.length, 1200)
  for (const [body, pattern] of [[[], /at least one/], [[null], /not valid/], [['abc', 5], /not valid/], [[0], /not valid/], [[-4], /not valid/], [[1.5], /not valid/], [[true], /not valid/], [Array.from({ length: 5001 }, (_, i) => i + 1), /at most 5000/]]) {
    const r = await perm(bin, body); assert.equal(r.code, 400, JSON.stringify(body).slice(0, 40)); assert.match(r.body.message, pattern); assert.equal(count(db, 'recycle_bin'), 1200)
  }
  const r = await perm(bin, ids); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1200); assert.equal(count(db, 'recycle_bin'), 0); assert.equal(count(db, 'reservations'), 1)
})
