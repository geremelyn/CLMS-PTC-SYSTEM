'use strict'
// CP128 - Teacher schedule delete/cancel (soft delete into the existing Recycle Bin).
// REAL: teacherScheduleController + recycleBinController SQL, run against in-memory SQLite (NOT MySQL; no HTTP server, no Express, no browser).
// Route/role gating is checked by reading the routes file (static), not by sending real requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')

const MIS = { id: 1, role: 'MIS', full_name: 'Super Admin' }, ANA = { id: 2, role: 'Teacher', full_name: 'Ana' }, BEN = { id: 3, role: 'Teacher', full_name: 'Ben' }
const DEAN = { id: 4, role: 'Dean', full_name: 'Dina' }, OTHER = { id: 5, role: 'Others', full_name: 'Lia' }, STAFF = { id: 6, role: 'Inventory Staff', full_name: 'Sam' }
function setup() {
  const db = createSqliteDb()
  db.sqlite.exec(`CREATE TABLE teacher_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, uploaded_by INTEGER NOT NULL, file_name TEXT NOT NULL, file_type TEXT, file_size INTEGER NOT NULL, file_data BLOB NOT NULL, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by INTEGER);
    INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(2,'ana','Ana','Teacher'),(3,'ben','Ben','Teacher'),(4,'dina','Dina','Dean'),(5,'lia','Lia','Others'),(6,'sam','Sam','Inventory Staff');`)
  const ins = db.sqlite.prepare('INSERT INTO teacher_schedules (teacher_id, uploaded_by, file_name, file_type, file_size, file_data) VALUES (?,?,?,?,?,?)')
  for (const [t, name] of [[2, 'ana.pdf'], [3, 'ben.pdf'], [4, 'dean.pdf'], [5, 'other.pdf']]) ins.run(t, t, name, 'application/pdf', 3, Buffer.from('PDF'))
  const { bin } = loadControllers(db)
  delete require.cache[path.resolve(__dirname, '../controllers/teacherScheduleController.js')]
  const sched = require('../controllers/teacherScheduleController.js')
  return { db, bin, sched }
}
const call = async (fn, user, extra = {}) => { const r = res(); r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v }; r.send = b => { r.sent = b; return r }; await fn({ user, params: {}, query: {}, body: {}, ...extra }, r); return r }
const active = db => db.sqlite.prepare('SELECT id FROM teacher_schedules WHERE deleted_at IS NULL ORDER BY id').all().map(r => r.id)

test('own-only delete: Teacher/Dean/Others delete their own; other people\'s schedules answer 404 and stay untouched', async () => {
  const { db, sched } = setup()
  assert.equal((await call(sched.deleteSchedule, ANA, { params: { id: '2' } })).code, 404, 'Ana cannot delete Ben\'s')
  assert.equal(count(db, 'recycle_bin'), 0); assert.deepEqual(active(db), [1, 2, 3, 4])
  assert.equal((await call(sched.deleteSchedule, ANA, { params: { id: '1' } })).code, 200)
  assert.equal((await call(sched.deleteSchedule, DEAN, { params: { id: '3' } })).code, 200)
  assert.equal((await call(sched.deleteSchedule, OTHER, { params: { id: '4' } })).code, 200)
  assert.deepEqual(active(db), [2])
  assert.equal((await call(sched.deleteSchedule, ANA, { params: { id: '1' } })).code, 404, 'already deleted')
  assert.equal(count(db, 'recycle_bin', "entity_type='teacher_schedules'"), 0, 'CP162: owner deletions never enter the Recycle Bin')
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules WHERE id IN (1,3,4)').get().n, 0, 'CP162: owner deletes are permanent')
})

test('MIS Head can delete any teacher\'s schedule; MIS Staff, unknown roles and bad ids are refused', async () => {
  const { db, sched } = setup()
  assert.equal((await call(sched.deleteSchedule, STAFF, { params: { id: '1' } })).code, 403)
  assert.equal((await call(sched.deleteSchedule, { id: 9, role: 'Janitor' }, { params: { id: '1' } })).code, 403)
  for (const id of ['abc', '0', '-1', '1.5']) assert.equal((await call(sched.deleteSchedule, MIS, { params: { id } })).code, 400, id)
  assert.deepEqual(active(db), [1, 2, 3, 4])
  assert.equal((await call(sched.deleteSchedule, MIS, { params: { id: '2' } })).code, 200)
  assert.deepEqual(active(db), [1, 3, 4])
})

test('deleted schedule disappears from list, View and Download for every role; file bytes are kept', async () => {
  const { db, sched } = setup()
  assert.equal((await call(sched.deleteSchedule, MIS, { params: { id: '1' } })).code, 200) // CP162: only Super Admin deletions are soft deletes
  for (const user of [MIS, STAFF, ANA]) {
    const list = await call(sched.listSchedules, user); assert.ok(!list.body.schedules.some(s => s.id === 1), `list ${user.role}`)
    assert.equal((await call(sched.viewSchedule, user, { params: { id: '1' } })).code, 404, `view ${user.role}`)
    assert.equal((await call(sched.downloadSchedule, user, { params: { id: '1' } })).code, 404, `download ${user.role}`)
  }
  assert.equal(db.sqlite.prepare('SELECT file_size FROM teacher_schedules WHERE id = 1').get().file_size, 3, 'row and file kept (soft delete)')
  const snap = JSON.parse(db.sqlite.prepare("SELECT snapshot_json FROM recycle_bin WHERE entity_type='teacher_schedules'").get().snapshot_json)
  assert.ok(!('file_data' in snap), 'no file bytes in the snapshot')
})

test('list marks can_delete per role (MIS all, owner own, MIS Staff never); existing View/Download still work for active rows', async () => {
  const { sched } = setup()
  const own = (await call(sched.listSchedules, ANA)).body.schedules; assert.deepEqual(own.map(s => [s.id, s.can_delete]), [[1, true]])
  assert.ok((await call(sched.listSchedules, MIS)).body.schedules.every(s => s.can_delete === true))
  assert.ok((await call(sched.listSchedules, STAFF)).body.schedules.every(s => s.can_delete === false))
  assert.equal((await call(sched.viewSchedule, ANA, { params: { id: '1' } })).code, 200)
  assert.equal((await call(sched.downloadSchedule, STAFF, { params: { id: '1' } })).code, 200)
  assert.equal((await call(sched.downloadSchedule, ANA, { params: { id: '2' } })).code, 404)
})

test('Recycle Bin: restore brings the schedule back; permanent delete removes the row; other modules are untouched', async () => {
  const { db, bin, sched } = setup()
  db.sqlite.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  db.sqlite.prepare("INSERT INTO computers (id, computer_name, laboratory_id, operational_status, \"condition\") VALUES (1,'PC-1',2,'ACTIVE','WORKING')").run()
  await call(sched.deleteSchedule, MIS, { params: { id: '1' } }); await call(sched.deleteSchedule, MIS, { params: { id: '2' } })
  const list = res(); await bin.listRecycleBin({ query: { type: 'teacher_schedules' }, user: MIS }, list)
  assert.equal(list.body.items.length, 2)
  const [first, second] = list.body.items.map(i => i.id).sort((a, b) => a - b)
  const restored = res(); await bin.restoreRecycleItem({ params: { id: String(first) }, user: MIS }, restored)
  assert.equal(restored.code, 200, JSON.stringify(restored.body)); assert.deepEqual(active(db), [1, 3, 4])
  assert.equal((await call(sched.downloadSchedule, ANA, { params: { id: '1' } })).code, 200, 'restored schedule downloadable again')
  const again = res(); await bin.restoreRecycleItem({ params: { id: String(first) }, user: MIS }, again); assert.equal(again.code, 409)
  const p = res(); await bin.permanentDeleteRecycleItems({ body: { ids: [second] }, user: MIS }, p)
  assert.equal(p.code, 200, JSON.stringify(p.body)); assert.equal(count(db, 'teacher_schedules', 'id = 2'), 0); assert.equal(count(db, 'teacher_schedules'), 3)
  assert.equal(count(db, 'computers'), 1, 'other modules untouched')
})

test('permanent delete never removes an ACTIVE schedule', async () => {
  const { db, bin } = setup()
  db.sqlite.prepare("INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json) VALUES ('teacher_schedules', 1, 'x', '{\"id\":1}')").run()
  const p = res(); await bin.permanentDeleteRecycleItems({ body: { ids: [1] }, user: MIS }, p)
  assert.equal(p.code, 200); assert.equal(count(db, 'teacher_schedules', 'id = 1'), 1, 'active row survives')
})

test('delete rolls back completely if the Recycle Bin insert fails', async () => {
  const { db, sched } = setup()
  db.state.failWhen = sql => (/INSERT INTO recycle_bin/.test(sql) ? new Error('boom') : null)
  assert.equal((await call(sched.deleteSchedule, MIS, { params: { id: '1' } })).code, 500) // CP162: the Recycle Bin path is Super Admin only
  assert.deepEqual(active(db), [1, 2, 3, 4]); assert.equal(count(db, 'recycle_bin'), 0)
})

test('routes: DELETE open to MIS/Teacher/Dean/Others only (not MIS Staff); schema adds the soft-delete columns; client has a confirm popup', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/teacherScheduleRoutes.js'), 'utf8')
  assert.match(routes, /router\.delete\('\/:id', requireRole\('MIS', 'Teacher', 'Dean', 'Others'\), deleteSchedule\)/)
  assert.match(fs.readFileSync(path.resolve(__dirname, '../database/ensureSchema.js'), 'utf8'), /addColumn\('teacher_schedules', 'deleted_at'/)
  const ui = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/TeacherSchedules.jsx'), 'utf8')
  assert.match(ui, /await confirm\([^]*danger: true/); assert.match(ui, /item\.can_delete/)
})
