// CP124 - final verification regression tests for the Teacher Schedule feature.
// MOCKED/OFFLINE: controller runs on in-memory node:sqlite behind a db.query adapter (NOT MySQL); no live HTTP; no browser.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')

function setup() {
  const sqlite = new DatabaseSync(':memory:'), seen = []
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, status TEXT DEFAULT 'ACTIVE');
    CREATE TABLE teacher_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, uploaded_by INTEGER NOT NULL, file_name TEXT NOT NULL, file_type TEXT, file_size INTEGER NOT NULL, file_data BLOB NOT NULL, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by INTEGER);
    INSERT INTO users VALUES (1,'admin','Super Admin','MIS','ACTIVE'),(2,'ana','Ana Santos','Teacher','ACTIVE'),(3,'ben','Ben Reyes','Teacher','ACTIVE'),(6,'staff','Sam Staff','Inventory Staff','ACTIVE');
    INSERT INTO teacher_schedules (teacher_id, uploaded_by, file_name, file_size, file_data) VALUES (2,2,'ana.pdf',1,x'41'),(3,3,'ben.pdf',1,x'42');`)
  const db = { query(sql, params, cb) { try { seen.push(params); const a = (params || []).map(v => (v === undefined ? null : v)); if (/^\s*SELECT/i.test(sql)) return cb(null, sqlite.prepare(sql).all(...a)); const r = sqlite.prepare(sql).run(...a); cb(null, { insertId: Number(r.lastInsertRowid) }) } catch (e) { cb(e) } } }
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../controllers/teacherScheduleController.js')]
  return { c: require('../controllers/teacherScheduleController.js'), seen, sqlite }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 6, role: 'Inventory Staff' }, ANA = { id: 2, role: 'Teacher' }

test('BUG FIX: malformed teacher_id from MIS / MIS Staff is a 400 and never reaches the database (was NaN / 1.5 / -3 passed straight to SQL)', async () => {
  const { c, seen } = setup()
  for (const user of [MIS, STAFF]) for (const teacher_id of ['abc', '1.5', '-3', '0', 'NaN', '1e999', ['1', '2'], { a: 1 }]) {
    const before = seen.length, r = res(); await c.listSchedules({ user, query: { teacher_id } }, r)
    assert.equal(r.code, 400, `${user.role} teacher_id=${JSON.stringify(teacher_id)}`); assert.equal(r.body.message, 'Invalid teacher.'); assert.equal(seen.length, before, 'no SQL was run')
  }
})

test('teacher_id filter still works when valid; empty value = no filter; search still combines; Teacher ignores the parameter entirely', async () => {
  const { c } = setup()
  let r = res(); await c.listSchedules({ user: MIS, query: { teacher_id: '3' } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ben.pdf'])
  r = res(); await c.listSchedules({ user: MIS, query: { teacher_id: 3 } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ben.pdf'], 'numeric value (as older tests pass it) is still valid')
  r = res(); await c.listSchedules({ user: STAFF, query: { teacher_id: '' } }, r); assert.equal(r.body.schedules.length, 2)
  r = res(); await c.listSchedules({ user: MIS, query: {} }, r); assert.equal(r.body.schedules.length, 2)
  r = res(); await c.listSchedules({ user: MIS, query: { teacher_id: '2', search: 'ana' } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ana.pdf'])
  r = res(); await c.listSchedules({ user: ANA, query: { teacher_id: 'abc' } }, r); assert.equal(r.code, 200); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ana.pdf'])
  r = res(); await c.listSchedules({ user: MIS, query: { search: 'ben' } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ben.pdf'])
  r = res(); await c.listSchedules({ user: STAFF, query: { search: 'ANA SAN' } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ana.pdf'])
})

test('PRESERVATION (static, whole server): nothing in the server source deletes/updates/drops/alters/truncates teacher_schedules except the CP128 soft-delete/restore/permanent-delete statements (deleted_at only); schema is create-if-not-exists only', () => {
  const root = path.resolve(__dirname, '..'), hits = []
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'test') continue; const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|sql)$/.test(e.name)) { const t = fs.readFileSync(f, 'utf8'); for (const m of t.matchAll(/(DELETE\s+FROM|UPDATE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|REPLACE\s+INTO)\s+`?teacher_schedules(?!\s+(?:SET\s+deleted_at|WHERE\s+deleted_at\s+IS\s+NOT\s+NULL))/gi)) hits.push(`${path.relative(root, f)}: ${m[0]}`) } } }
  walk(root)
  // CP162: the controller's two hard DELETEs (owner delete of own schedule; uploader Undo) are the only other statements allowed.
  assert.deepEqual(hits, ['controllers/teacherScheduleController.js: DELETE FROM teacher_schedules', 'controllers/teacherScheduleController.js: DELETE FROM teacher_schedules'])
  assert.match(fs.readFileSync(path.join(root, 'database/ensureSchema.js'), 'utf8'), /CREATE TABLE IF NOT EXISTS teacher_schedules/)
})

test('REUSE / RESERVATIONS (static): reservation code and pages do not read, require or mention schedule uploads', () => {
  const root = path.resolve(__dirname, '..', '..')
  for (const f of ['server/routes/reservationRoutes.js', 'server/controllers/reservationController.js', 'server/config/reservationPolicy.js', 'server/config/reservationTime.js', 'server/config/reservationPeriods.js', 'server/utils/pendingReservationExpiry.js', 'client/src/pages/Reservations.jsx', 'client/src/pages/MyReservations.jsx']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /teacher_schedules|teacher-schedules|teacherSchedule|TeacherSchedules/i, f)
})
