// CP121 - Teacher schedule upload (Teachers + MIS Head/Super Admin). The real controller runs against a real SQL engine (node:sqlite, in-memory).
// Role gating of routes and menus is checked from source. NOT covered: real MySQL LONGBLOB / max_allowed_packet, live HTTP (see CP121 notes).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

function setup() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, status TEXT DEFAULT 'ACTIVE');
    CREATE TABLE teacher_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, uploaded_by INTEGER NOT NULL, file_name TEXT NOT NULL, file_type TEXT, file_size INTEGER NOT NULL, file_data BLOB NOT NULL, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by INTEGER);
    INSERT INTO users VALUES (1,'admin','Super Admin','MIS','ACTIVE'),(2,'t-ana','Ana Teacher','Teacher','ACTIVE'),(3,'t-ben','Ben Teacher','Teacher','ACTIVE'),(4,'dean1','Dean D','Dean','ACTIVE'),(5,'t-old','Old Teacher','Teacher','INACTIVE');`)
  const audits = []
  const db = { query(sql, params, cb) {
    try {
      const args = (params || []).map(v => (v === undefined ? null : v))
      if (/^\s*(SELECT|WITH)/i.test(sql)) return cb(null, sqlite.prepare(sql).all(...args))
      const r = sqlite.prepare(sql).run(...args); cb(null, { insertId: Number(r.lastInsertRowid), affectedRows: r.changes })
    } catch (error) { cb(error) }
  } }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), ctl = path.resolve(__dirname, '../controllers/teacherScheduleController.js')
  for (const [p, exp] of [[dbPath, db], [auditPath, { logAudit: (...a) => audits.push(a) }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[ctl]
  return { c: require(ctl), sqlite, audits }
}
const res = () => ({ code: 200, body: null, headers: {}, sent: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this }, setHeader(k, v) { this.headers[k] = v }, send(b) { this.sent = b; return this } })
const MIS = { id: 1, role: 'MIS', full_name: 'Super Admin' }, ANA = { id: 2, role: 'Teacher', full_name: 'Ana Teacher' }, BEN = { id: 3, role: 'Teacher', full_name: 'Ben Teacher' }
const b64 = text => Buffer.from('%PDF-' + text).toString('base64') // CP162: uploads must be real PDFs
const up = async (c, user, body) => { const r = res(); await c.uploadSchedule({ user, body }, r); return r }

test('Teacher uploads their own schedule: saved, audited, bytes kept exactly', async () => {
  const { c, sqlite, audits } = setup()
  const r = await up(c, ANA, { fileName: 'ana-schedule.pdf', fileType: 'application/pdf', fileBase64: b64('%PDF-fake-bytes') })
  assert.equal(r.code, 201)
  const row = sqlite.prepare('SELECT * FROM teacher_schedules').get()
  assert.equal(row.teacher_id, 2); assert.equal(row.uploaded_by, 2); assert.equal(row.file_size, 20)
  assert.equal(Buffer.from(row.file_data).toString(), '%PDF-%PDF-fake-bytes')
  assert.equal(audits.length, 1); assert.equal(audits[0][1], 'TEACHER SCHEDULE UPLOAD')
})

test('Teacher cannot upload for another teacher (403, nothing saved); own id is accepted', async () => {
  const { c, sqlite } = setup()
  assert.equal((await up(c, ANA, { fileName: 'x.pdf', fileBase64: b64('a'), teacherId: 3 })).code, 403)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 0)
  assert.equal((await up(c, ANA, { fileName: 'x.pdf', fileBase64: b64('a'), teacherId: 2 })).code, 201)
})

test('MIS uploads on behalf of a chosen active Teacher; a missing/unknown/non-teacher/inactive choice is rejected', async () => {
  const { c, sqlite } = setup()
  assert.equal((await up(c, MIS, { fileName: 'a.pdf', fileBase64: b64('img') })).code, 400)
  for (const teacherId of [999, 4, 1, 5, 'abc']) assert.equal((await up(c, MIS, { fileName: 'a.pdf', fileBase64: b64('img'), teacherId })).code, 400, `teacherId ${teacherId}`)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 0)
  const ok = await up(c, MIS, { fileName: 'a.pdf', fileBase64: b64('img'), teacherId: 3 })
  assert.equal(ok.code, 201)
  const row = sqlite.prepare('SELECT teacher_id, uploaded_by FROM teacher_schedules').get()
  assert.deepEqual({ ...row }, { teacher_id: 3, uploaded_by: 1 })
})

test('bad input: no file name, empty or malformed content; path parts and control characters are stripped from the name', async () => {
  const { c, sqlite } = setup()
  assert.equal((await up(c, ANA, { fileBase64: b64('a') })).code, 400)
  assert.equal((await up(c, ANA, { fileName: 'a.pdf', fileBase64: '' })).code, 400)
  assert.equal((await up(c, ANA, { fileName: 'a.pdf', fileBase64: '!!!notbase64***' })).code, 400)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 0)
  assert.equal((await up(c, ANA, { fileName: '..\\..\\etc/pass"wd<1>.pdf', fileBase64: b64('a') })).code, 201)
  assert.equal(sqlite.prepare('SELECT file_name FROM teacher_schedules').get().file_name, 'passwd1.pdf')
  assert.equal(c.cleanFileName('C:\\fakepath\\My Schedule.xlsx'), 'My Schedule.xlsx')
})

test('every upload is kept: a second upload never replaces or deletes the first (no replacement policy invented)', async () => {
  const { c, sqlite } = setup()
  await up(c, ANA, { fileName: 'v1.pdf', fileBase64: b64('one') })
  await up(c, ANA, { fileName: 'v1.pdf', fileBase64: b64('two') })
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 2)
})

test('list: Teacher sees only their own (no file data); MIS sees all and can filter by teacher', async () => {
  const { c } = setup()
  await up(c, ANA, { fileName: 'ana.pdf', fileBase64: b64('a') }); await up(c, BEN, { fileName: 'ben.pdf', fileBase64: b64('b') }); await up(c, MIS, { fileName: 'by-admin.pdf', fileBase64: b64('c'), teacherId: 2 })
  let r = res(); await c.listSchedules({ user: ANA, query: {} }, r)
  assert.deepEqual(r.body.schedules.map(s => s.file_name).sort(), ['ana.pdf', 'by-admin.pdf'])
  assert.ok(r.body.schedules.every(s => !('file_data' in s)))
  assert.equal(r.body.schedules.find(s => s.file_name === 'by-admin.pdf').uploaded_by_name, 'Super Admin')
  r = res(); await c.listSchedules({ user: ANA, query: { teacher_id: 3 } }, r)
  assert.ok(r.body.schedules.every(s => s.teacher_id === 2), 'a Teacher cannot widen the list with ?teacher_id')
  r = res(); await c.listSchedules({ user: MIS, query: {} }, r); assert.equal(r.body.schedules.length, 3)
  r = res(); await c.listSchedules({ user: MIS, query: { teacher_id: 3 } }, r); assert.deepEqual(r.body.schedules.map(s => s.file_name), ['ben.pdf'])
})

test('verification download: owner and MIS get the exact file as an attachment; another Teacher gets 404', async () => {
  const { c } = setup()
  await up(c, ANA, { fileName: 'ana "sched".pdf', fileType: 'application/pdf', fileBase64: b64('<script>1</script>') })
  let r = res(); await c.downloadSchedule({ user: ANA, params: { id: '1' } }, r)
  assert.equal(r.code, 200); assert.equal(Buffer.from(r.sent).toString(), '%PDF-<script>1</script>')
  assert.match(r.headers['Content-Disposition'], /^attachment;/); assert.equal(r.headers['X-Content-Type-Options'], 'nosniff')
  assert.ok(!/"sched"/.test(r.headers['Content-Disposition'].split(';')[1]), 'quotes removed from the plain filename')
  r = res(); await c.downloadSchedule({ user: MIS, params: { id: '1' } }, r); assert.equal(r.code, 200)
  r = res(); await c.downloadSchedule({ user: BEN, params: { id: '1' } }, r); assert.equal(r.code, 404); assert.equal(r.sent, null)
  r = res(); await c.downloadSchedule({ user: MIS, params: { id: '99' } }, r); assert.equal(r.code, 404)
  r = res(); await c.downloadSchedule({ user: MIS, params: { id: 'x' } }, r); assert.equal(r.code, 400)
})

test('teacher picker for MIS lists active Teachers only', async () => {
  const { c } = setup(); const r = res(); await c.listTeachers({ user: MIS }, r)
  assert.deepEqual(r.body.teachers.map(t => t.username), ['t-ana', 't-ben'])
})

test('permissions (CP123-updated): upload = MIS + Teacher + Dean + custom roles; list/download also MIS Staff (view only); teacher picker MIS only; mounted', () => {
  const routes = read('../routes/teacherScheduleRoutes.js')
  assert.match(routes, /router\.get\('\/teachers', requireRole\('MIS'\)/)
  assert.match(routes, /router\.post\('\/', requireRole\('MIS', 'Teacher', 'Dean', 'Others'\)/)
  for (const verb of ["get\\('/'", "get\\('/:id/download'"]) assert.match(routes, new RegExp(`router\\.${verb}, requireRole\\('MIS', 'Inventory Staff', 'Teacher', 'Dean', 'Others'\\)`))
  assert.doesNotMatch(routes, /router\.(put|patch)/) // CP128: DELETE /:id added
  assert.match(read('../server.js'), /app\.use\('\/api\/teacher-schedules', require\('\.\/routes\/teacherScheduleRoutes\.js'\)\)/)
  const layout = read('../../client/src/components/AppLayout.jsx')
  const access = layout.match(/ROUTE_ACCESS = \{[\s\S]*?\n\}/)[0].split('\n')
  const line = role => access.find(l => l.trim().startsWith(`${role}:`))
  assert.match(line('MIS'), /\/teacher-schedules/); assert.match(line('Teacher'), /\/teacher-schedules/); assert.match(line("'Inventory Staff'"), /\/teacher-schedules/)
  for (const role of ['Dean', 'Others']) assert.match(line(role), /\/teacher-schedules/, role)
  assert.match(read('../../client/src/App.jsx'), /path="\/teacher-schedules"/)
  assert.match(read('../database/ensureSchema.js'), /CREATE TABLE IF NOT EXISTS teacher_schedules/)
})

test('reservation workflow untouched: reservation routes/controller do not mention teacher schedules', () => {
  for (const f of ['../routes/reservationRoutes.js', '../controllers/reservationController.js']) assert.doesNotMatch(read(f), /teacher_schedules|teacher-schedules/)
})
