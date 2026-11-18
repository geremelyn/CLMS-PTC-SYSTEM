'use strict'
// CP162 - Teacher schedule workflow (PDF-only, Undo, owner delete vs Super Admin Recycle Bin, username search, client wiring).
// REAL: controllers' SQL on in-memory SQLite (NOT MySQL). Calls controllers directly: no HTTP, no Express, no browser.
// Client checks are static source checks only (UI not executed in this test file).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const MIS = { id: 1, role: 'MIS', full_name: 'Super Admin' }, ANA = { id: 2, role: 'Teacher', full_name: 'Ana' }, BEN = { id: 3, role: 'Teacher', full_name: 'Ben' }
const DEAN = { id: 4, role: 'Dean', full_name: 'Dina' }, OTHER = { id: 5, role: 'Others', full_name: 'Lia' }, STAFF = { id: 6, role: 'Inventory Staff', full_name: 'Sam' }
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')
function setup() {
  const db = createSqliteDb()
  db.sqlite.exec(`CREATE TABLE teacher_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, uploaded_by INTEGER NOT NULL, file_name TEXT NOT NULL, file_type TEXT, file_size INTEGER NOT NULL, file_data BLOB NOT NULL, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT NULL, deleted_by INTEGER NULL);
    INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(2,'ana','Ana','Teacher'),(3,'ben','Ben','Teacher'),(4,'dina','Dina','Dean'),(5,'lia','Lia','Others'),(6,'sam','Sam','Inventory Staff');`)
  const { bin } = loadControllers(db)
  delete require.cache[path.resolve(__dirname, '../controllers/teacherScheduleController.js')]
  return { db, bin, sched: require('../controllers/teacherScheduleController.js') }
}
const call = async (fn, user, extra = {}) => { const r = res(); r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v }; r.send = b => { r.sent = b; return r }; await fn({ user, params: {}, query: {}, body: {}, ...extra }, r); return r }
const up = (s, user, name, bytes, type = 'application/pdf', extra = {}) => call(s.sched.uploadSchedule, user, { body: { fileName: name, fileType: type, fileBase64: bytes.toString('base64'), ...extra } })
const rows = db => count(db, 'teacher_schedules')

test('PDF-only upload (server): real PDF accepted; non-PDF names, spoofed content, wrong declared type and Excel/image/HTML are rejected with nothing saved', async () => {
  const s = setup()
  assert.equal((await up(s, ANA, 'sched.pdf', PDF)).code, 201)
  assert.equal((await up(s, ANA, 'SCHED2.PDF', PDF, '')).code, 201, 'uppercase extension / no declared type is fine')
  for (const [name, bytes, type] of [['load.xlsx', Buffer.from('PK\u0003\u0004xl'), 'application/vnd.ms-excel'], ['a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'], ['a.html', Buffer.from('<b>x</b>'), 'text/html'],
    ['fake.pdf', Buffer.from('plain text renamed'), 'application/pdf'], ['xlsx-as.pdf', Buffer.from('PK\u0003\u0004'), 'application/pdf'], ['real.pdf.exe', PDF, 'application/pdf'], ['real.pdf', PDF, 'image/png']]) {
    const r = await up(s, ANA, name, bytes, type); assert.equal(r.code, 400, name); assert.match(r.body.message, /Only PDF files/)
  }
  assert.equal((await up(s, MIS, 'x.xlsx', Buffer.from('x'), 'application/vnd.ms-excel', { teacherId: 2 })).code, 400)
  assert.equal(rows(s.db), 2)
})

test('Undo upload: only the uploader can undo; removes the row, writes nothing to the Recycle Bin; others get 404; MIS Staff 403', async () => {
  const s = setup(); const id = String((await up(s, ANA, 'a.pdf', PDF)).body.schedule.id)
  assert.equal((await call(s.sched.undoUpload, BEN, { params: { id } })).code, 404)
  assert.equal((await call(s.sched.undoUpload, MIS, { params: { id } })).code, 404, 'not even Super Admin can "undo" someone else\'s upload')
  assert.equal((await call(s.sched.undoUpload, STAFF, { params: { id } })).code, 403)
  assert.equal((await call(s.sched.undoUpload, ANA, { params: { id: 'abc' } })).code, 400)
  assert.equal(rows(s.db), 1)
  assert.equal((await call(s.sched.undoUpload, ANA, { params: { id } })).code, 200)
  assert.equal(rows(s.db), 0); assert.equal(count(s.db, 'recycle_bin'), 0)
  assert.equal((await call(s.sched.undoUpload, ANA, { params: { id } })).code, 404, 'second undo')
})

test('Recycle Bin rules: Teacher/Dean/Others delete = permanent, NO Recycle Bin row; Super Admin delete = Recycle Bin row, restorable', async () => {
  const s = setup()
  const ids = {}; for (const [u, k] of [[ANA, 'ana'], [DEAN, 'dean'], [OTHER, 'other'], [BEN, 'ben']]) ids[k] = String((await up(s, u, `${k}.pdf`, PDF)).body.schedule.id)
  for (const [u, k] of [[ANA, 'ana'], [DEAN, 'dean'], [OTHER, 'other']]) assert.equal((await call(s.sched.deleteSchedule, u, { params: { id: ids[k] } })).code, 200)
  assert.equal(count(s.db, 'recycle_bin'), 0); assert.equal(rows(s.db), 1)
  assert.equal((await call(s.bin.listRecycleBin, MIS)).body.items.length, 0, 'MIS Recycle Bin shows nothing for owner deletions')
  assert.equal((await call(s.sched.deleteSchedule, MIS, { params: { id: ids.ben } })).code, 200)
  const items = (await call(s.bin.listRecycleBin, MIS)).body.items
  assert.equal(items.length, 1); assert.equal(items[0].entity_type, 'teacher_schedules')
  assert.equal(rows(s.db), 1, 'Super Admin delete is a soft delete (row kept for restore)')
})

test('Recycle Bin list hides legacy teacher-made schedule deletions (CP128 rows) but keeps Super Admin ones', async () => {
  const s = setup()
  const ins = s.db.sqlite.prepare("INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ('teacher_schedules', ?, ?, '{}', ?)")
  ins.run(10, 'Schedule: old-by-teacher.pdf (Ana)', 2); ins.run(11, 'Schedule: by-admin.pdf (Ana)', 1)
  const items = (await call(s.bin.listRecycleBin, MIS)).body.items
  assert.deepEqual(items.map(i => i.entity_id), [11])
})

test('Permissions preserved: MIS Staff cannot delete; other people\'s schedules answer 404; own-only list; View still serves the real PDF inline', async () => {
  const s = setup(); const a = String((await up(s, ANA, 'a.pdf', PDF)).body.schedule.id), b = String((await up(s, BEN, 'b.pdf', PDF)).body.schedule.id)
  assert.equal((await call(s.sched.deleteSchedule, STAFF, { params: { id: a } })).code, 403)
  assert.equal((await call(s.sched.deleteSchedule, ANA, { params: { id: b } })).code, 404)
  assert.deepEqual((await call(s.sched.listSchedules, ANA)).body.schedules.map(x => x.file_name), ['a.pdf'])
  assert.equal((await call(s.sched.viewSchedule, BEN, { params: { id: a } })).code, 404)
  const v = await call(s.sched.viewSchedule, STAFF, { params: { id: a } }); assert.equal(v.code, 200); assert.match(v.headers['Content-Disposition'], /^inline/); assert.ok(Buffer.from(v.sent).equals(PDF))
  assert.equal(rows(s.db), 2)
})

test('Search matches teacher name OR username for MIS and MIS Staff', async () => {
  const s = setup(); await up(s, ANA, 'a.pdf', PDF); await up(s, BEN, 'b.pdf', PDF)
  for (const u of [MIS, STAFF]) { assert.deepEqual((await call(s.sched.listSchedules, u, { query: { search: 'ben' } })).body.schedules.map(x => x.file_name), ['b.pdf']); assert.equal((await call(s.sched.listSchedules, u, { query: { search: 'ANA' } })).body.schedules.length, 1) }
})

test('Routes + client wiring (static): undo route uploader roles only; page = PDF check, confirm preview, Undo, View/Delete only, no Download, no MIS upload form, 5-row typeable pager', () => {
  const routes = read('../routes/teacherScheduleRoutes.js')
  assert.match(routes, /router\.post\('\/:id\/undo-upload', requireRole\('MIS', 'Teacher', 'Dean', 'Others'\)/)
  const page = read('../../client/src/pages/TeacherSchedules.jsx')
  assert.match(page, /Only PDF files can be uploaded/); assert.match(page, /%PDF-/); assert.match(page, /Confirm Upload/); assert.match(page, /undo-upload/); assert.match(page, /label: 'Undo'/)
  assert.match(page, /canUpload = \['Teacher', 'Dean', 'Others'\]/); // CP163: Download exists only behind viewAll (Super Admin / MIS Staff); never for the own-only roles.
  assert.equal((page.match(/>Download</g) || []).length, 2); assert.equal((page.match(/\{viewAll && <><button type="button" onClick=\{\(\) => download\(/g) || []).length, 2)
  assert.match(page, /const viewAll = isMis \|\| isStaff/); assert.match(page, /\}\/download`, \{ responseType: 'blob' \}/)
  assert.match(page, />View</); assert.match(page, />Delete</)
  assert.match(page, /const pageSize = 5/); assert.ok(!/Rows <select/.test(page), 'no rows-per-page dropdown (CP187)'); assert.match(page, /aria-label="Page number"/); assert.match(page, />Previous</); assert.match(page, />Next</)
})
