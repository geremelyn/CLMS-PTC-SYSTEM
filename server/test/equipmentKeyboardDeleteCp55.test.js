'use strict'
// CP55 regression tests: why an Equipment record (e.g. a Keyboard) is refused deletion, and that the refusal is traceable.
// SQLITE tests (real controller SQL on SQLite, NOT MySQL/MariaDB). No real MySQL/MariaDB database, HTTP server or browser was used.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }

function seed() {
  const db = createSqliteDb(), s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  s.prepare("INSERT INTO computers (id, computer_name, laboratory_id, asset_tag, serial_number, operational_status, \"condition\") VALUES (3,'PC-3',2,'PC-TAG-3','PCSN-3','ACTIVE','WORKING')").run()
  const eq = s.prepare('INSERT INTO equipment (id, equipment_type, laboratory_id, computer_id, asset_tag, serial_number, status) VALUES (?,?,?,?,?,?,?)')
  eq.run(10, 'Keyboard', 2, null, 'KB-010', 'KSN-010', 'WORKING')
  eq.run(11, 'Mouse', 2, null, 'MS-011', 'MSN-011', 'WORKING')
  eq.run(12, 'Projector', 2, null, 'PJ-012', 'PSN-012', 'WORKING')
  return db
}
const maint = (db, equipmentId, status, date, computerId = null) => db.sqlite.prepare('INSERT INTO maintenance (equipment_id, computer_id, reported_by, status, date_reported) VALUES (?,?,7,?,?)').run(equipmentId, computerId, status, date)
async function bulk(db, body, type = 'equipment') { const { bulk: b } = loadControllers(db), r = res(); await b.createBulkRecordController(type).bulkDelete({ body, user: MIS }, r); return r }

test('ROOT CAUSE: a Keyboard with a maintenance row (here a COMPLETED history row) is refused, and the refusal names that exact row', async () => {
  const db = seed(); maint(db, 10, 'COMPLETED', '2026-09-03 10:00:00')
  const r = await bulk(db, { ids: [10] })
  assert.equal(r.code, 409); assert.equal(r.body.deletedCount, 0); assert.equal(r.body.skippedCount, 1)
  assert.match(r.body.message, /Every selected record is still referenced by maintenance history\./)   // no longer says "equipment or"
  assert.match(r.body.message, /Maintenance #1 COMPLETED, reported 2026-09-03/)
  assert.deepEqual(r.body.skipped[0].references, [{ table: 'maintenance', id: 1, status: 'COMPLETED', reported: '2026-09-03', alsoComputerId: null }])
})
test('history is preserved: nothing is deleted, no Recycle Bin or undo rows are created, the maintenance row is untouched', async () => {
  const db = seed(); maint(db, 10, 'CLOSED', '2026-09-03 10:00:00')
  await bulk(db, { ids: [10] })
  assert.equal(count(db, 'equipment', 'id = 10'), 1); assert.equal(count(db, 'maintenance'), 1); assert.equal(count(db, 'recycle_bin'), 0); assert.equal(count(db, 'undo_actions'), 0)
})
test('an ACTIVE (PENDING / IN PROGRESS) maintenance report also blocks and is identified with its status', async () => {
  const db = seed(); maint(db, 10, 'PENDING', '2026-10-01 08:00:00'); maint(db, 10, 'IN PROGRESS', '2026-10-05 08:00:00')
  const r = await bulk(db, { ids: [10] })
  assert.equal(r.code, 409); assert.match(r.body.message, /Maintenance #1 PENDING, reported 2026-10-01; Maintenance #2 IN PROGRESS, reported 2026-10-05/)
})
test('many references: the first three are named and the rest are counted', async () => {
  const db = seed(); for (let i = 0; i < 5; i++) maint(db, 10, 'COMPLETED', '2026-09-0' + (i + 1) + ' 10:00:00')
  const r = await bulk(db, { ids: [10] }); assert.match(r.body.message, /and 2 more/); assert.equal(r.body.skipped[0].references.length, 5)
})
test('a legacy row linked to BOTH a computer and the equipment is flagged (the Maintenance page shows such a row as the computer, hiding the keyboard)', async () => {
  const db = seed(); maint(db, 10, 'COMPLETED', '2026-09-03 10:00:00', 3)
  const r = await bulk(db, { ids: [10] }); assert.match(r.body.message, /also linked to computer #3/); assert.equal(r.body.skipped[0].references[0].alsoComputerId, 3)
})
test('UNCHANGED: unreferenced equipment still deletes into the Recycle Bin and undo restores it', async () => {
  const db = seed(); maint(db, 10, 'COMPLETED', '2026-09-03 10:00:00')
  const r = await bulk(db, { ids: [11, 12] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 2); assert.equal(count(db, 'recycle_bin', "entity_type='equipment'"), 2)
  const { bulk: b } = loadControllers(db), u = res(); await b.createBulkRecordController('equipment').undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200); assert.equal(count(db, 'equipment'), 3)
})
test('UNCHANGED: a mixed selection deletes the unreferenced ones, skips and names the referenced Keyboard', async () => {
  const db = seed(); maint(db, 10, 'COMPLETED', '2026-09-03 10:00:00')
  const r = await bulk(db, { ids: [10, 11, 12], skipLinked: true })
  assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 2); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 10)
  assert.match(r.body.skipped[0].reason, /^Still referenced by maintenance history \(Maintenance #1 COMPLETED/); assert.deepEqual(db.sqlite.prepare('SELECT id FROM equipment').all().map(x => x.id), [10])
})
test('UNCHANGED: a Keyboard WITHOUT any maintenance row deletes normally (and a maintenance row of ANOTHER item does not block it)', async () => {
  const db = seed(); maint(db, 11, 'COMPLETED', '2026-09-03 10:00:00')
  const r = await bulk(db, { ids: [10] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1)
})
test('UNCHANGED: computers keep their wording and rule (referenced by equipment or maintenance history)', async () => {
  const db = seed(); maint(db, null, 'COMPLETED', '2026-09-03 10:00:00', 3)
  const r = await bulk(db, { ids: [3] }, 'computers'); assert.equal(r.code, 409); assert.match(r.body.message, /referenced by equipment or maintenance history/); assert.match(r.body.message, /Maintenance #1 COMPLETED/)
})
