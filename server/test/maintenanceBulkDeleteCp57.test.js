'use strict'
// CP57: Maintenance / Maintenance History selection + deletion.
// SQLITE tests (real controller SQL on SQLite, NOT MySQL/MariaDB) + MOCKED role stubs + source-level frontend contract tests.
// No real MySQL/MariaDB database, HTTP server, Vite build or browser was used.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 2, role: 'Inventory Staff' }
const STATUS = { 1: 'PENDING', 2: 'IN PROGRESS', 3: 'COMPLETED', 4: 'CLOSED' }

function seed() {
  const db = createSqliteDb(), s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(2,'st','Staff','Inventory Staff'),(7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  s.prepare("INSERT INTO computers (id, computer_name, laboratory_id, asset_tag, serial_number, operational_status, \"condition\") VALUES (3,'PC-3',2,'PC-TAG-3','PCSN-3','UNDER REPAIR','WORKING')").run()
  s.prepare("INSERT INTO equipment (id, equipment_type, laboratory_id, computer_id, asset_tag, serial_number, status) VALUES (10,'Keyboard',2,NULL,'KB-010','KSN-010','UNDER REPAIR')").run()
  const m = s.prepare('INSERT INTO maintenance (id, computer_id, equipment_id, reported_by, issue_description, status, date_reported) VALUES (?,?,?,?,?,?,?)')
  m.run(1, 3, null, 7, 'Screen flickers', 'PENDING', '2026-10-01 08:00:00')
  m.run(2, null, 10, 7, 'Keys stuck', 'IN PROGRESS', '2026-10-02 08:00:00')
  m.run(3, 3, null, 7, 'No power', 'COMPLETED', '2026-09-01 08:00:00')
  m.run(4, null, 10, 7, 'Cable loose', 'CLOSED', '2026-09-02 08:00:00')
  return db
}
async function del(db, body, user = MIS) { const { bulk } = loadControllers(db), r = res(); await bulk.createBulkRecordController('maintenance').bulkDelete({ body, user }, r); return r }
const statuses = db => db.sqlite.prepare('SELECT id, status FROM maintenance ORDER BY id').all().map(x => `${x.id}:${x.status}`)

test('selected History records (COMPLETED/CLOSED) are deleted into the Recycle Bin; assets and other records are untouched', async () => {
  const db = seed(), r = await del(db, { ids: [3, 4] })
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 2); assert.equal(r.body.skippedCount, 0)
  assert.deepEqual(statuses(db), ['1:PENDING', '2:IN PROGRESS'])
  assert.equal(count(db, 'recycle_bin', "entity_type='maintenance' AND restored_at IS NULL"), 2)
  assert.equal(count(db, 'computers'), 1); assert.equal(count(db, 'equipment'), 1)
  assert.equal(db.sqlite.prepare('SELECT status FROM equipment WHERE id=10').get().status, 'UNDER REPAIR') // asset state not changed by deleting history
  assert.match(r.body.deletedRecords[0].label, /Maintenance #3 \(COMPLETED/)
})
test('a PENDING record can be deleted (it has not changed any asset)', async () => {
  const db = seed(), r = await del(db, { ids: [1] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1)
})
test('IN PROGRESS is protected: skipped and reported, never deleted; a request with only IN PROGRESS is a 409 that changes nothing', async () => {
  const db = seed()
  let r = await del(db, { ids: [2] }); assert.equal(r.code, 409); assert.match(r.body.message, /IN PROGRESS records cannot be deleted: the asset is under repair/); assert.equal(count(db, 'maintenance'), 4); assert.equal(count(db, 'recycle_bin'), 0)
  r = await del(db, { ids: [1, 2, 3, 4], skipLinked: true }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 3); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 2)
  assert.deepEqual(statuses(db), ['2:IN PROGRESS'])
})
test('empty, missing and invalid ids are refused and nothing is deleted', async () => {
  const db = seed()
  for (const body of [{ ids: [] }, {}, { ids: [3, 'x'] }, { ids: [0] }]) { const r = await del(db, body); assert.equal(r.code, 400, JSON.stringify(body)) }
  assert.equal(count(db, 'maintenance'), 4)
})
test('an id that no longer exists is skipped and reported; the rest is deleted', async () => {
  const db = seed(), r = await del(db, { ids: [3, 999] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skipped[0].id, 999)
})
test('Recycle Bin restore: a deleted record returns exactly as it was (status, text, dates, links)', async () => {
  const db = seed(), { bin } = loadControllers(db), before = db.sqlite.prepare('SELECT * FROM maintenance WHERE id = 3').get()
  const r = await del(db, { ids: [3] }); const item = db.sqlite.prepare("SELECT id FROM recycle_bin WHERE entity_type='maintenance'").get()
  const back = res(); await bin.restoreRecycleItems({ body: { ids: [item.id] }, user: MIS }, back); assert.equal(back.code, 200, JSON.stringify(back.body))
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM maintenance WHERE id = 3').get(), before); assert.equal(r.code, 200)
})
test('Undo restores the whole deletion; undo is refused when the asset was deleted meanwhile (no orphan history)', async () => {
  const db = seed(), { bulk } = loadControllers(db), actions = bulk.createBulkRecordController('maintenance')
  const r = await del(db, { ids: [3, 4] }); const u = res(); await actions.undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.equal(count(db, 'maintenance'), 4)
  const r2 = await del(db, { ids: [4] }); db.sqlite.prepare('DELETE FROM equipment WHERE id = 10').run() // asset removed while its history sat in the Recycle Bin
  const u2 = res(); await actions.undoDelete({ params: { undoId: String(r2.body.undoActionId) }, user: MIS }, u2)
  assert.equal(u2.code, 409); assert.match(u2.body.message, /equipment this maintenance record belongs to no longer exists/); assert.equal(count(db, 'maintenance', 'id = 4'), 0)
})
test('Recycle Bin restore is refused when the reporting user no longer exists', async () => {
  const db = seed(), { bin } = loadControllers(db); await del(db, { ids: [3] })
  db.sqlite.prepare('DELETE FROM users WHERE id = 7').run()
  const item = db.sqlite.prepare("SELECT id FROM recycle_bin WHERE entity_type='maintenance'").get(), back = res()
  await bin.restoreRecycleItems({ body: { ids: [item.id] }, user: MIS }, back); assert.equal(back.code, 409); assert.match(back.body.message, /user who reported this issue no longer exists/)
})
test('equipment/computer reference rules are unchanged: an asset that still has maintenance rows still cannot be deleted', async () => {
  const db = seed(), { bulk } = loadControllers(db), r = res(); await bulk.createBulkRecordController('equipment').bulkDelete({ body: { ids: [10] }, user: MIS }, r)
  assert.equal(r.code, 409); assert.equal(count(db, 'equipment'), 1)
  await del(db, { ids: [4] }); const r2 = res(); await bulk.createBulkRecordController('equipment').bulkDelete({ body: { ids: [10] }, user: MIS }, r2); assert.equal(r2.code, 409) // #2 still references it
})
test('Delete All of 1,205 History records goes to the Recycle Bin in chunks and restores', async () => {
  const db = seed(), s = db.sqlite, ins = s.prepare("INSERT INTO maintenance (id, computer_id, reported_by, issue_description, status, date_reported) VALUES (?,3,7,'bulk','CLOSED','2026-01-01 08:00:00')")
  for (let i = 0; i < 1201; i++) ins.run(100 + i)
  const ids = s.prepare("SELECT id FROM maintenance WHERE status IN ('COMPLETED','CLOSED')").all().map(x => x.id)
  const r = await del(db, { ids, skipLinked: true }); assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200)); assert.equal(r.body.deletedCount, 1203); assert.equal(count(db, 'maintenance'), 2)
  const { bulk } = loadControllers(db), u = res(); await bulk.createBulkRecordController('maintenance').undoDelete({ params: { undoId: String(r.body.undoActionId) }, user: MIS }, u)
  assert.equal(u.code, 200, JSON.stringify(u.body)); assert.equal(count(db, 'maintenance'), 1205)
})
test('a database failure rolls everything back (nothing deleted, no Recycle Bin rows)', async () => {
  const db = seed(), realGet = db.getConnection
  db.getConnection = cb => realGet((error, conn) => { const q = conn.query.bind(conn); conn.query = (sql, values, done) => /^\s*DELETE FROM maintenance/.test(String(sql)) ? done(Object.assign(new Error('boom'), { code: 'ER_X' })) : q(sql, values, done); cb(error, conn) })
  const r = await del(db, { ids: [3, 4] }); assert.equal(r.code, 500); assert.equal(count(db, 'maintenance'), 4); assert.equal(count(db, 'recycle_bin'), 0)
})

// ---- roles ----
test('routes: bulk-delete/undo are limited to MIS and MIS Staff (Inventory Staff); Teacher/Dean can only create reports', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../routes/maintenanceRoutes.js'), 'utf8')
  for (const needle of ["'/bulk-delete'", "'/undo-bulk-delete/:undoId'"]) { const line = src.split('\n').find(l => l.includes(needle)); assert.match(line, /requireRole\('MIS', 'Inventory Staff'\)/); assert.doesNotMatch(line, /Teacher|Dean/) }
  assert.match(src.split('\n').find(l => l.startsWith("router.post('/', ")), /requireRole\('Teacher','Dean','Others'\)/)
})
test('the real requireRole gate returns 403 for Teacher and Dean and passes MIS and MIS Staff', async () => {
  const Module = require('node:module'), { createSessionToken } = require('../utils/sessionToken.js'), roles = { Teacher: 7, Dean: 8, 'Inventory Staff': 2, MIS: 1 }
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stub('../database/db.js', { query(sql, values, cb) { if (/session_revocations/.test(sql)) return cb(null, []); const id = Number(values[0]); const role = Object.keys(roles).find(name => roles[name] === id); cb(null, [{ id, full_name: role, username: role, role, status: 'ACTIVE' }]) } })
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
  const gate = require('../middleware/roleAuth.js').requireRole('MIS', 'Inventory Staff')
  const run = id => new Promise(resolve => { const r = res(), json = r.json.bind(r); r.json = b => { json(b); resolve({ r, passed: false }); return r }; gate({ header: name => name === 'authorization' ? `Bearer ${createSessionToken(id)}` : '' }, r, () => resolve({ r, passed: true })) })
  for (const id of [1, 2]) assert.equal((await run(id)).passed, true)
  for (const id of [7, 8]) { const out = await run(id); assert.equal(out.passed, false); assert.equal(out.r.code, 403) }
})

// ---- frontend contract (source-level) ----
const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Maintenance.jsx'), 'utf8')
test('page: checkbox column, Select All, Clear Selection, Delete (N) and Delete All exist and are role-gated', () => {
  assert.match(page, /const canDeleteMaintenance = canUpdateMaintenance/)
  for (const text of ["allInViewSelected ? 'Clear Selection' : 'Select All'", 'Delete ({selectedInView.length})', '>Delete All</button>', 'aria-label="Select all records in this list"', 'Select maintenance record']) assert.ok(page.includes(text), text)
  // CP113: the buttons now live in the page toolbar (renderBulkControls), still role-gated
  // CP169: the bar also hosts History's Save as PDF, so the wrapper is (canDeleteMaintenance || withPdf); every selection/delete button stays individually gated.
  assert.match(page, /\(canDeleteMaintenance \|\| withPdf\) \? <div className=\{`maintenance-bulk-bar no-print/)
  // CP188: Select All and Clear Selection are ONE toggle button (label flips once the whole list is selected).
  for (const gated of ["allInViewSelected ? 'Clear Selection' : 'Select All'", '>Delete All</button>']) assert.ok(new RegExp(`canDeleteMaintenance &&[^\\n]*${gated.replace(/[()/?]/g, '\\$&')}`).test(page), `${gated} is role-gated`)
})
test('page: deletion confirms first, never sends IN PROGRESS rows, posts to /maintenance/bulk-delete and offers Restore', () => {
  const fn = page.slice(page.indexOf('async function deleteMaintenanceRecords'), page.indexOf('function renderMaintenanceTable'))
  assert.ok(fn.indexOf('await confirm(') > -1 && fn.indexOf('await confirm(') < fn.indexOf('api.post'))
  assert.match(fn, /!== 'IN PROGRESS'/); assert.match(fn, /\/maintenance\/bulk-delete/); assert.match(fn, /undo-bulk-delete/); assert.match(fn, /label: 'Restore'/)
})
test('Clear Selection / Select All never call the API (no confirmation needed for UI-only actions)', () => {
  const bar = page.slice(page.indexOf('maintenance-bulk-bar no-print'), page.indexOf('function renderMaintenanceTable'))
  assert.match(bar, /setSelectedIds\(allInViewSelected \? \[\] : current =>/); assert.doesNotMatch(bar.split('Delete (')[0], /api\.|confirm\(/)
})
test('search covers what the table displays (custom status, MIS Staff, formatted dates)', () => {
  assert.match(page, /record\.status_other, formatStatus\(record\.status\), record\.reported_by_role === 'Inventory Staff' \? 'MIS Staff' : ''/); assert.match(page, /formatDate\(record\.date_reported\)/)
})
test('Recycle Bin page labels the new Maintenance type', () => {
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/RecycleBin.jsx'), 'utf8'), /maintenance: 'Maintenance'/)
})
