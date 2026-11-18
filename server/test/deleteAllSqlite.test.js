'use strict'
// SQLITE regression tests for bulk delete / Delete All (Revision 10, CP13 Final).
// These run the REAL controller SQL against an in-memory SQLite database (real transactions + rollback).
// They are NOT MySQL/MariaDB tests: MySQL-specific behaviour (row locks, deadlocks, packet limits, ENUM/strict mode)
// is only simulated by injecting the error codes MySQL raises. Real MySQL/MariaDB was NOT used.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')

const MIS = { id: 1, role: 'MIS' }
function seed(db, { computers = 0, linkedComputers = [], reservations = 0, equipment = 0, linkedEquipment = [] } = {}) {
  const s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'), (7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  const pc = s.prepare("INSERT INTO computers (id, computer_name, laboratory_id, asset_tag, serial_number, operational_status, \"condition\") VALUES (?,?,?,?,?,?,?)")
  for (let i = 1; i <= computers; i++) pc.run(i, `PC-${i}`, 2, `TAG-${i}`, `SN-${i}`, 'ACTIVE', 'WORKING')
  const eq = s.prepare("INSERT INTO equipment (id, equipment_type, laboratory_id, computer_id, asset_tag, serial_number, status) VALUES (?,?,?,?,?,?,?)")
  for (let i = 1; i <= equipment; i++) eq.run(i, `Projector ${i}`, 2, null, `EQ-${i}`, `ESN-${i}`, 'ACTIVE')
  for (const id of linkedComputers) eq.run(10000 + id, 'Monitor', 2, id, `LEQ-${id}`, `LESN-${id}`, 'ACTIVE') // equipment attached to a computer
  for (const id of linkedEquipment) s.prepare('INSERT INTO maintenance (equipment_id, reported_by) VALUES (?, 7)').run(id)
  const rs = s.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name) VALUES (?,?,?,?,?,?,?,?)")
  for (let i = 1; i <= reservations; i++) rs.run(i, 2, 7, `2026-11-10`, `${String(7 + (i % 10)).padStart(2, '0')}:00:00`, `${String(8 + (i % 10)).padStart(2, '0')}:00:00`, 'DECLINED', `Subject ${i}`)
}
const ids = n => Array.from({ length: n }, (_, i) => i + 1)

test('SQLite: Computers Delete All of 750 records (above the old 500 cap and across chunks) deletes all, fills the Recycle Bin and undo restores all', async () => {
  const db = createSqliteDb(); seed(db, { computers: 750 }); const { bulk } = loadControllers(db)
  const actions = bulk.createBulkRecordController('computers'), r = res()
  await actions.bulkDelete({ body: { ids: ids(750), skipLinked: true }, user: MIS }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200)); assert.equal(r.body.deletedCount, 750); assert.equal(r.body.skippedCount, 0)
  assert.equal(count(db, 'computers'), 0); assert.equal(count(db, 'recycle_bin', "entity_type='computers' AND restored_at IS NULL"), 750)
  const u = res(); await actions.undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.equal(count(db, 'computers'), 750)
  assert.equal(count(db, 'recycle_bin', 'restored_at IS NOT NULL'), 750)
})

test('SQLite: Delete Selected and Delete All give the same result: linked computers are skipped AND reported, counts add up, history kept', async () => {
  for (const skipLinked of [false, true]) {
    const db = createSqliteDb(); seed(db, { computers: 6, linkedComputers: [2, 5] }); const { bulk } = loadControllers(db)
    const r = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: ids(6), skipLinked }, user: MIS }, r)
    assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 4); assert.equal(r.body.skippedCount, 2)
    assert.equal(r.body.deletedCount + r.body.skippedCount, 6, 'no record unaccounted for')
    assert.deepEqual(r.body.skipped.map(item => item.id).sort(), [2, 5]); assert.match(r.body.skipped[0].reason, /equipment/)
    assert.deepEqual(db.sqlite.prepare('SELECT id FROM computers ORDER BY id').all().map(x => x.id), [2, 5]); assert.equal(count(db, 'equipment', 'computer_id IN (2,5)'), 2)
  }
})

test('SQLite: a computer deleted by another user meanwhile is skipped and reported (not a failure of the whole batch)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 5 }); const { bulk } = loadControllers(db)
  db.sqlite.prepare('DELETE FROM computers WHERE id = 3').run() // the other user's delete, after this user's list was loaded
  const r = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: ids(5), skipLinked: true }, user: MIS }, r)
  assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 4); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 3); assert.match(r.body.skipped[0].reason, /deleted by someone else/)
  assert.equal(count(db, 'computers'), 0)
})

test('SQLite: when every record is linked or gone the request is 409 and NOTHING changes (no false success)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 2, linkedComputers: [1, 2] }); const { bulk } = loadControllers(db)
  const r = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: [1, 2], skipLinked: true }, user: MIS }, r)
  assert.equal(r.code, 409); assert.equal(r.body.deletedCount, 0); assert.equal(count(db, 'computers'), 2); assert.equal(count(db, 'recycle_bin'), 0); assert.equal(count(db, 'undo_actions'), 0)
  const gone = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: [998, 999] }, user: MIS }, gone)
  assert.equal(gone.code, 409); assert.equal(gone.body.skippedCount, 2)
})

test('SQLite: a failure in the LAST chunk rolls everything back (no half-deleted batch, empty Recycle Bin, 500 reported, not success)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 450 }); const { bulk } = loadControllers(db)
  let deletes = 0
  db.state.failWhen = sql => sql.startsWith('DELETE FROM computers') && ++deletes === 3 ? Object.assign(new Error('simulated driver failure'), { code: 'ER_UNKNOWN' }) : null
  const r = res(); const originalError = console.error; console.error = () => {}
  try { await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: ids(450), skipLinked: true }, user: MIS }, r) } finally { console.error = originalError }
  assert.equal(r.code, 500); assert.match(r.body.message, /Nothing was deleted/)
  assert.equal(count(db, 'computers'), 450); assert.equal(count(db, 'recycle_bin'), 0); assert.equal(count(db, 'undo_actions'), 0)
})

test('SQLite (simulated MySQL deadlock code): a deadlock is a clear 409, nothing deleted, for computers, reservations, users and laboratories', async () => {
  const db = createSqliteDb(); seed(db, { computers: 3, reservations: 3 }); db.sqlite.prepare("INSERT INTO users (id, username, full_name, role) VALUES (20,'t20','Free Teacher','Teacher')").run(); db.sqlite.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (30,'Free Lab',10,'OPEN')").run()
  const { bulk, bin } = loadControllers(db)
  db.state.failWhen = sql => sql.startsWith('DELETE FROM') ? Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' }) : null
  const calls = [['computers', () => bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: [1, 2, 3] }, user: MIS }, r1)], ['reservations', () => bin.deleteReservations({ body: { ids: [1, 2, 3] }, user: MIS }, r2)], ['users', () => bin.deleteUsers({ body: { ids: [20] }, user: MIS }, r3)], ['laboratories', () => bin.deleteLaboratories({ body: { ids: [30] }, user: MIS }, r4)]]
  const r1 = res(), r2 = res(), r3 = res(), r4 = res()
  for (const [, run] of calls) await run()
  for (const r of [r1, r2, r3, r4]) { assert.equal(r.code, 409, JSON.stringify(r.body)); assert.match(r.body.message, /Nothing was deleted/) }
  assert.equal(count(db, 'computers'), 3); assert.equal(count(db, 'reservations'), 3); assert.equal(count(db, 'users', 'id=20'), 1); assert.equal(count(db, 'laboratories', 'id=30'), 1); assert.equal(count(db, 'recycle_bin'), 0)
})

test('SQLite: Equipment Delete All skips records referenced by maintenance history, reports them, and undo restores the rest', async () => {
  const db = createSqliteDb(); seed(db, { equipment: 5, linkedEquipment: [4] }); const { bulk } = loadControllers(db)
  const actions = bulk.createBulkRecordController('equipment'), r = res()
  await actions.bulkDelete({ body: { ids: ids(5), skipLinked: true }, user: MIS }, r)
  assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 4); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 4)
  assert.deepEqual(db.sqlite.prepare('SELECT id FROM equipment ORDER BY id').all().map(x => x.id), [4])
  const u = res(); await actions.undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.equal(count(db, 'equipment'), 5)
})

test('SQLite: Reservations Delete All (450 rows, chunked) -> Recycle Bin -> Restore all; individual delete still works', async () => {
  const db = createSqliteDb(); seed(db, { reservations: 450 }); const { bin } = loadControllers(db)
  const r = res(); await bin.deleteReservations({ body: { ids: ids(450), skipMissing: true }, user: MIS }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200)); assert.equal(r.body.deletedCount, 450); assert.equal(r.body.recycleIds.length, 450)
  assert.equal(count(db, 'reservations'), 0); assert.equal(count(db, 'recycle_bin', "entity_type='reservations' AND restored_at IS NULL"), 450)
  const back = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, back)
  assert.equal(back.code, 200, JSON.stringify(back.body)); assert.equal(back.body.restoredCount, 450); assert.equal(count(db, 'reservations'), 450)
  const single = res(); await bin.deleteReservations({ body: { ids: [7] }, user: MIS }, single)
  assert.equal(single.code, 200); assert.equal(single.body.deletedCount, 1); assert.equal(count(db, 'reservations'), 449)
})

test('SQLite: Reservations Delete Selected and Delete All both skip + report a reservation deleted by someone else; counts are accurate', async () => {
  for (const skipMissing of [false, true]) {
    const db = createSqliteDb(); seed(db, { reservations: 5 }); const { bin } = loadControllers(db)
    db.sqlite.prepare('DELETE FROM reservations WHERE id = 2').run()
    const r = res(); await bin.deleteReservations({ body: { ids: ids(5), skipMissing }, user: MIS }, r)
    assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 4); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 2)
    assert.equal(count(db, 'reservations'), 0); assert.equal(count(db, 'recycle_bin', "entity_type='reservations'"), 4)
  }
})

test('SQLite: restoring a Delete All batch is all-or-nothing when one reservation now clashes with a new active booking', async () => {
  const db = createSqliteDb(); seed(db, { reservations: 3 }); db.sqlite.prepare("UPDATE reservations SET status='CANCELLED', start_time='09:00:00', end_time='10:00:00' WHERE id=1").run()
  const { bin } = loadControllers(db)
  const r = res(); await bin.deleteReservations({ body: { ids: [1, 2, 3] }, user: MIS }, r); assert.equal(r.code, 200)
  // CP53: active reservations can no longer be deleted, so an item that restores as PENDING is a legacy Recycle Bin item from before CP53; simulate it.
  db.sqlite.prepare("UPDATE recycle_bin SET snapshot_json = REPLACE(snapshot_json, '\"status\":\"CANCELLED\"', '\"status\":\"PENDING\"') WHERE entity_type='reservations' AND entity_id=1").run()
  db.sqlite.prepare("INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status) VALUES (99,2,7,'2026-11-10','09:30:00','10:30:00','APPROVED')").run()
  const back = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, back)
  assert.equal(back.code, 409); assert.match(back.body.message, /Nothing was restored/); assert.equal(count(db, 'reservations'), 1); assert.equal(count(db, 'recycle_bin', 'restored_at IS NOT NULL'), 0)
})

test('SQLite: Users Delete All deletes free accounts, skips + reports MIS, self and accounts with history; Recycle Bin restores them', async () => {
  const db = createSqliteDb(); seed(db, { reservations: 1 }) // user 7 owns a reservation
  db.sqlite.prepare("INSERT INTO users (id, username, full_name, role) VALUES (20,'t20','Free One','Teacher'), (21,'t21','Free Two','Dean'), (22,'self','Me Myself','Inventory Staff')").run()
  const { bin } = loadControllers(db)
  const r = res(); await bin.deleteUsers({ body: { ids: [1, 7, 20, 21, 22] }, user: { id: 22, role: 'Inventory Staff' } }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 2); assert.equal(r.body.skippedCount, 3)
  assert.deepEqual(r.body.skipped.map(item => item.id).sort((a, b) => a - b), [1, 7, 22]); assert.deepEqual(db.sqlite.prepare('SELECT id FROM users ORDER BY id').all().map(x => x.id), [1, 7, 22])
  const back = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, back); assert.equal(back.code, 200, JSON.stringify(back.body)); assert.equal(count(db, 'users'), 5)
})

test('SQLite: Laboratories delete skips + reports a lab still used by computers, deletes a free one, and restores it', async () => {
  const db = createSqliteDb(); seed(db, { computers: 1 }); db.sqlite.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (30,'Free Lab',10,'OPEN')").run()
  const { bin } = loadControllers(db)
  const r = res(); await bin.deleteLaboratories({ body: { ids: [2, 30] }, user: MIS }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 2); assert.match(r.body.skipped[0].reason, /computer/)
  const only = res(); await bin.deleteLaboratories({ body: { ids: [2] }, user: MIS }, only); assert.equal(only.code, 409); assert.equal(count(db, 'laboratories', 'id=2'), 1)
  const back = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, back); assert.equal(back.code, 200, JSON.stringify(back.body)); assert.equal(count(db, 'laboratories'), 2)
})

test('SQLite: invalid id lists are rejected before touching the database (0, empty, over 5000)', async () => {
  const db = createSqliteDb(); seed(db, { computers: 1 }); const { bulk, bin } = loadControllers(db)
  for (const bad of [[], 'x', [0], [1.5], ids(5001)]) {
    const a = res(), b = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids: bad }, user: MIS }, a); await bin.deleteReservations({ body: { ids: bad }, user: MIS }, b)
    assert.equal(a.code, 400); assert.equal(b.code, 400)
  }
  assert.equal(count(db, 'computers'), 1)
})
