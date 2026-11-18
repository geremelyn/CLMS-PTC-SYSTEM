'use strict'
// CP74 regression: computer deletion when equipment / maintenance history reference the computer.
// SQLITE (real controller SQL on SQLite, NOT MySQL/MariaDB; the SQLite schema has no foreign keys, exactly like the project's MySQL schema files) +
// MOCKED db/audit stubs + source-level frontend checks. No browser, no real Express/HTTP, no real MySQL/MariaDB.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 2, role: 'Inventory Staff' }

function seed() {
  const db = createSqliteDb(), s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(2,'staff','MIS Staff','Inventory Staff')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (1,'Lab 1',40,'OPEN')").run()
  for (const [id, tag] of [[1, 'PC-FREE'], [2, 'PC-EQUIP'], [3, 'PC-MAINT'], [4, 'PC-BOTH']]) s.prepare("INSERT INTO computers (id, computer_name, laboratory_id, asset_tag, operational_status, condition) VALUES (?,?,?,?,'ACTIVE','WORKING')").run(id, tag, 1, tag)
  s.prepare("INSERT INTO equipment (id, equipment_type, laboratory_id, computer_id, asset_tag, status) VALUES (10,'MOUSE',1,2,'EQ-10','WORKING'),(11,'KEYBOARD',1,4,'EQ-11','WORKING')").run()
  s.prepare("INSERT INTO maintenance (id, computer_id, equipment_id, reported_by, status, issue_description) VALUES (20,3,NULL,1,'RESOLVED','No display'),(21,4,NULL,1,'PENDING','Fan noise')").run()
  return db
}
function loadComputerController(db) {
  const { bulk, bin } = loadControllers(db)
  delete require.cache[path.resolve(__dirname, '../controllers/computerController.js')]
  return { computer: require('../controllers/computerController.js'), bulk, bin }
}
async function singleDelete(db, id, user = MIS) { const { computer } = loadComputerController(db); const r = res(); await new Promise(resolve => { const done = r.json.bind(r); r.json = b => { done(b); resolve(); return r }; computer.deleteComputer({ params: { id: String(id) }, body: {}, user }, r) }); return r }
async function bulkDelete(db, ids, user = MIS, extra = {}) { const { bulk } = loadControllers(db); const r = res(); await bulk.createBulkRecordController('computers').bulkDelete({ body: { ids, ...extra }, user }, r); return r }
const rows = q => q.all().map(r => ({ ...r })); const equip = db => rows(db.sqlite.prepare('SELECT id, computer_id FROM equipment ORDER BY id')), maint = db => rows(db.sqlite.prepare('SELECT id, computer_id FROM maintenance ORDER BY id'))

test('CP74 single delete (DELETE /computers/:id): a computer referenced by equipment is REFUSED with 409 and nothing changes', async () => {
  const db = seed(), r = await singleDelete(db, 2)
  assert.equal(r.code, 409, JSON.stringify(r.body)); assert.equal(count(db, 'computers'), 4); assert.equal(count(db, 'recycle_bin'), 0)
  assert.deepEqual(equip(db), [{ id: 10, computer_id: 2 }, { id: 11, computer_id: 4 }])
})
test('CP74 single delete: a computer with maintenance history is REFUSED; the maintenance records keep their computer', async () => {
  const db = seed(), r = await singleDelete(db, 3)
  assert.equal(r.code, 409, JSON.stringify(r.body)); assert.equal(count(db, 'computers', 'id = 3'), 1); assert.deepEqual(maint(db), [{ id: 20, computer_id: 3 }, { id: 21, computer_id: 4 }])
})
test('CP74 the refusal explains WHAT blocks it (equipment / maintenance history, with the maintenance record) and WHAT TO DO', async () => {
  const db = seed(), both = (await singleDelete(db, 4)).body.message
  assert.match(both, /equipment and maintenance history/); assert.match(both, /Maintenance #21 PENDING/); assert.match(both, /What to do/i); assert.match(both, /Equipment page/); assert.match(both, /RETIRED/)
  const eq = (await singleDelete(db, 2)).body.message; assert.match(eq, /equipment/); assert.match(eq, /What to do/i)
})
test('CP74 single delete of a free computer works exactly like the page: Recycle Bin snapshot + undo record, and it is restorable', async () => {
  const db = seed(), r = await singleDelete(db, 1); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 1)
  assert.equal(count(db, 'computers', 'id = 1'), 0); assert.equal(count(db, 'recycle_bin', "entity_type='computers' AND entity_id=1 AND restored_at IS NULL"), 1)
  const { bulk } = loadControllers(db), u = res(); await bulk.createBulkRecordController('computers').undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.equal(count(db, 'computers', 'id = 1'), 1)
})
test('CP74 bulk delete: linked computers are skipped and reported, the free one is deleted, history and relationships stay intact', async () => {
  const db = seed(), r = await bulkDelete(db, [1, 2, 3, 4]); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skippedCount, 3); assert.deepEqual(db.sqlite.prepare('SELECT id FROM computers ORDER BY id').all().map(x => x.id), [2, 3, 4])
  assert.equal(equip(db).length, 2); assert.equal(maint(db).length, 2); assert.match(r.body.message, /What to do/i)
})
test('CP74 bulk delete of only linked computers: 409, nothing deleted', async () => {
  const db = seed(), r = await bulkDelete(db, [2, 3, 4]); assert.equal(r.code, 409); assert.equal(r.body.deletedCount, 0); assert.equal(count(db, 'computers'), 4); assert.match(r.body.message, /still referenced by equipment or maintenance history/)
})
test('CP74 once the linked equipment is removed (Equipment page) the computer can be deleted; maintenance history still blocks forever (kept for the record)', async () => {
  const db = seed(); db.sqlite.prepare('DELETE FROM equipment WHERE computer_id = 2').run()
  assert.equal((await singleDelete(db, 2)).code, 200); assert.equal((await singleDelete(db, 3)).code, 409)
})
test('CP74 invalid id is rejected with 400 before any SQL; permissions are unchanged (route: MIS + Inventory Staff only)', async () => {
  const db = seed(); for (const id of ['0', '-1', 'abc', '1.5', '']) { const r = await singleDelete(db, id); assert.equal(r.code, 400, id) } assert.equal(count(db, 'computers'), 4)
  assert.match(fs.readFileSync(path.resolve(__dirname, '../routes/computerRoutes.js'), 'utf8'), /router\.delete\('\/:id', requireRole\('MIS','Inventory Staff'\), deleteComputer\)/)
  assert.equal((await singleDelete(db, 1, STAFF)).code, 200)
})
test('CP74 the Computers page deletes through bulk-delete and shows the server explanation (no vague message)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Computers.jsx'), 'utf8')
  assert.match(src, /api\.post\('\/computers\/bulk-delete', \{ ids: \[id\] \}\)/); assert.match(src, /setMessage\(error\.response\?\.data\?\.message \|\| 'Unable to delete computer'\)/)
})
