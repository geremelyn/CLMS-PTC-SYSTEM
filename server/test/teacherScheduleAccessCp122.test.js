// CP122 - Teacher schedule access completion.
// MOCKED/ADAPTED (not MySQL): the real controller runs against an in-memory node:sqlite engine through a tiny db.query adapter;
// the routes file is loaded with a stub express Router + stub requireRole so the real role lists are captured (no live HTTP).
// NOT covered: real MySQL (LIKE collation, LONGBLOB, max_allowed_packet), real Express/JWT middleware, browser UI.
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
    INSERT INTO users VALUES (1,'admin','Super Admin','MIS','ACTIVE'),(2,'t-ana','Ana Santos','Teacher','ACTIVE'),(3,'t-ben','Ben Reyes','Teacher','ACTIVE'),
      (4,'dean1','Dean D','Dean','ACTIVE'),(5,'t-old','Old Teacher','Teacher','INACTIVE'),(6,'staff1','Sam Staff','Inventory Staff','ACTIVE'),(7,'t-100','100%_Sure Teacher','Teacher','ACTIVE');`)
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
const MIS = { id: 1, role: 'MIS', full_name: 'Super Admin' }, ANA = { id: 2, role: 'Teacher', full_name: 'Ana Santos' }, BEN = { id: 3, role: 'Teacher', full_name: 'Ben Reyes' }
const STAFF = { id: 6, role: 'Inventory Staff', full_name: 'Sam Staff' }, DEAN = { id: 4, role: 'Dean', full_name: 'Dean D' }
const b64 = t => Buffer.from('%PDF-' + t).toString('base64') // CP162: uploads must be real PDFs
const up = async (c, user, body) => { const r = res(); await c.uploadSchedule({ user, body }, r); return r }
const list = async (c, user, query = {}) => { const r = res(); await c.listSchedules({ user, query }, r); return r }
const names = r => r.body.schedules.map(s => s.file_name).sort()
async function seed(c) {
  await up(c, ANA, { fileName: 'ana.pdf', fileBase64: b64('ANA') })
  await up(c, BEN, { fileName: 'ben.pdf', fileBase64: b64('BEN') })
  await up(c, MIS, { fileName: 'ana-by-admin.pdf', fileBase64: b64('ANA2'), teacherId: 2 })
  await up(c, MIS, { fileName: 'pct.pdf', fileBase64: b64('PCT'), teacherId: 7 })
}

// ---------- permissions ----------
test('PERMISSIONS Teacher: uploads, lists and downloads ONLY own schedules (other teacher = 404, ?teacher_id/search cannot widen)', async () => {
  const { c } = setup(); await seed(c)
  assert.deepEqual(names(await list(c, ANA)), ['ana-by-admin.pdf', 'ana.pdf'])
  assert.deepEqual(names(await list(c, ANA, { teacher_id: 3 })), ['ana-by-admin.pdf', 'ana.pdf'])
  assert.deepEqual(names(await list(c, ANA, { search: 'Ben' })), ['ana-by-admin.pdf', 'ana.pdf'])
  let r = res(); await c.downloadSchedule({ user: ANA, params: { id: '1' } }, r); assert.equal(r.code, 200)
  r = res(); await c.downloadSchedule({ user: ANA, params: { id: '2' } }, r); assert.equal(r.code, 404); assert.equal(r.sent, null)
  assert.equal((await up(c, ANA, { fileName: 'x.pdf', fileBase64: b64('x'), teacherId: 3 })).code, 403)
})

test('PERMISSIONS MIS Head/Super Admin: uploads for any active teacher, lists and downloads all', async () => {
  const { c, sqlite } = setup(); await seed(c)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules WHERE uploaded_by = 1').get().n, 2)
  assert.equal((await list(c, MIS)).body.schedules.length, 4)
  for (const id of [1, 2, 3, 4]) { const r = res(); await c.downloadSchedule({ user: MIS, params: { id: String(id) } }, r); assert.equal(r.code, 200) }
})

test('PERMISSIONS MIS Staff: lists + downloads ALL schedules (exact bytes, attachment); cannot upload (403, nothing saved, no audit)', async () => {
  const { c, sqlite, audits } = setup(); await seed(c)
  const before = audits.length
  assert.equal((await list(c, STAFF)).body.schedules.length, 4)
  const r = res(); await c.downloadSchedule({ user: STAFF, params: { id: '2' } }, r)
  assert.equal(r.code, 200); assert.equal(Buffer.from(r.sent).toString(), '%PDF-BEN'); assert.match(r.headers['Content-Disposition'], /^attachment;/)
  for (const body of [{ fileName: 's.pdf', fileBase64: b64('s'), teacherId: 2 }, { fileName: 's.pdf', fileBase64: b64('s') }]) assert.equal((await up(c, STAFF, body)).code, 403)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 4)
  assert.equal(audits.length, before)
  // CP128: MIS Staff may not delete (controller refuses on its own, nothing changes).
  const del = res(); await c.deleteSchedule({ user: STAFF, params: { id: '2' } }, del)
  assert.equal(del.code, 403); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules WHERE deleted_at IS NULL').get().n, 4)
})

test('PERMISSIONS Dean cannot upload for another user (CP123 gives Dean own-only upload)', async () => {
  const { c } = setup()
  assert.equal((await up(c, DEAN, { fileName: 'd.pdf', fileBase64: b64('d'), teacherId: 2 })).code, 403)
})

test('PERMISSIONS routes (real routes file, stub router): GET list/download = MIS+Inventory Staff+Teacher; POST = MIS+Teacher; /teachers = MIS; nothing else (no delete/put)', () => {
  const file = path.resolve(__dirname, '../routes/teacherScheduleRoutes.js')
  const table = []
  const router = {}; for (const verb of ['get', 'post', 'put', 'patch', 'delete']) router[verb] = (p, guard, handler) => table.push({ verb, p, roles: guard.roles, handler })
  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'express') return { Router: () => router }
    if (request === '../middleware/roleAuth.js') return { requireRole: (...roles) => Object.assign(() => {}, { roles }) }
    return originalLoad.call(this, request, ...rest)
  }
  try { setup(); delete require.cache[file]; require(file) } finally { Module._load = originalLoad }
  const find = (verb, p) => table.find(r => r.verb === verb && r.p === p)
  assert.deepEqual([...find('get', '/').roles].sort(), ['Dean', 'Inventory Staff', 'MIS', 'Others', 'Teacher'])
  assert.deepEqual([...find('get', '/:id/download').roles].sort(), ['Dean', 'Inventory Staff', 'MIS', 'Others', 'Teacher'])
  assert.deepEqual([...find('post', '/').roles].sort(), ['Dean', 'MIS', 'Others', 'Teacher'])
  assert.deepEqual(find('get', '/teachers').roles, ['MIS'])
  assert.deepEqual([...find('get', '/:id/view').roles].sort(), ['Dean', 'Inventory Staff', 'MIS', 'Others', 'Teacher'])
  assert.equal(table.length, 7, 'exactly seven routes (CP127 view, CP128 delete, CP162 undo-upload): no put/patch')
  assert.deepEqual([...find('delete', '/:id').roles].sort(), ['Dean', 'MIS', 'Others', 'Teacher'], 'CP128: MIS Staff excluded from delete')
})

// ---------- search ----------
test('SEARCH by teacher name: partial, case-insensitive, trimmed; MIS and MIS Staff; inactive teachers\' history stays searchable', async () => {
  const { c, sqlite } = setup(); await seed(c)
  for (const user of [MIS, STAFF]) {
    assert.deepEqual(names(await list(c, user, { search: 'ana' })), ['ana-by-admin.pdf', 'ana.pdf'])
    assert.deepEqual(names(await list(c, user, { search: '  REYES ' })), ['ben.pdf'])
    assert.deepEqual(names(await list(c, user, { search: 'na s' })), ['ana-by-admin.pdf', 'ana.pdf'], 'substring across the space in "Ana Santos"')
  }
  sqlite.prepare("INSERT INTO teacher_schedules (teacher_id, uploaded_by, file_name, file_size, file_data) VALUES (5, 1, 'old.pdf', 1, x'00')").run()
  assert.deepEqual(names(await list(c, STAFF, { search: 'old teacher' })), ['old.pdf'], 'inactive teacher history stays searchable')
  assert.equal((await list(c, MIS, { search: 'nobody' })).body.schedules.length, 0)
  assert.equal((await list(c, MIS, { search: '' })).body.schedules.length, 5, 'empty search = full list')
  assert.equal((await list(c, MIS, { search: 'ana', teacher_id: 3 })).body.schedules.length, 0, 'search combines (AND) with teacher_id')
})

test('SEARCH is a name search only: file name / username do not match; % and _ and ! are literal, not wildcards; injection text is inert', async () => {
  const { c, sqlite } = setup(); await seed(c)
  assert.equal((await list(c, MIS, { search: 'pdf' })).body.schedules.length, 0, 'file name is not searched')
  assert.equal((await list(c, MIS, { search: 't-ana' })).body.schedules.length, 2, 'CP162: username is searched too (Ana has 2 uploads)')
  assert.equal((await list(c, MIS, { search: '%' })).body.schedules.length, 1, '% matches only the teacher literally named 100%_Sure')
  assert.equal((await list(c, MIS, { search: '_' })).body.schedules.length, 1)
  assert.equal((await list(c, MIS, { search: 'A_a' })).body.schedules.length, 0, '_ is not a single-char wildcard')
  assert.equal((await list(c, MIS, { search: '!' })).body.schedules.length, 0)
  assert.equal((await list(c, MIS, { search: "x'; DROP TABLE teacher_schedules;--" })).body.schedules.length, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 4)
  assert.equal((await list(c, MIS, { search: 'a'.repeat(500) })).code, 200, 'long input is capped, not an error')
})

// ---------- upload / reuse / download ----------
test('UPLOAD still works for Teacher and MIS (audit kept) and the ORIGINAL bytes are returned unchanged by download', async () => {
  const { c, audits } = setup()
  const bytes = Buffer.from([37, 80, 68, 70, 45, 0, 255, 10, 13, 200]) // %PDF- + binary
  assert.equal((await up(c, ANA, { fileName: 'cor.pdf', fileType: 'application/pdf', fileBase64: bytes.toString('base64') })).code, 201)
  assert.equal((await up(c, MIS, { fileName: 'b.pdf', fileBase64: b64('b'), teacherId: 3 })).code, 201)
  assert.equal(audits.filter(a => a[1] === 'TEACHER SCHEDULE UPLOAD').length, 2)
  const r = res(); await c.downloadSchedule({ user: STAFF, params: { id: '1' } }, r)
  assert.deepEqual(Buffer.from(r.sent), bytes)
})

test('REUSE: one upload stays listed/downloadable repeatedly for the teacher, MIS and MIS Staff (nothing consumed or deleted); several uploads coexist', async () => {
  const { c, sqlite } = setup()
  await up(c, ANA, { fileName: 'cor.pdf', fileBase64: b64('COR') })
  for (let i = 0; i < 3; i++) for (const user of [ANA, MIS, STAFF]) {
    const r = res(); await c.downloadSchedule({ user, params: { id: '1' } }, r); assert.equal(Buffer.from(r.sent).toString(), '%PDF-COR')
    assert.equal((await list(c, user)).body.schedules.length, 1)
  }
  await up(c, ANA, { fileName: 'cor-v2.pdf', fileBase64: b64('COR2') })
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 2)
})

test('REUSE: reservation code never reads or requires a schedule upload; reservation page shows no schedule upload step; existing reservation rules untouched', () => {
  for (const f of ['../routes/reservationRoutes.js', '../controllers/reservationController.js', '../config/reservationPolicy.js', '../config/reservationTime.js', '../config/reservationPeriods.js']) assert.doesNotMatch(read(f), /teacher_schedules|teacher-schedules|teacherSchedule/i, f)
  assert.doesNotMatch(read('../../client/src/pages/Reservations.jsx'), /teacher-schedules|schedule upload|upload.*(COR|schedule)/i)
  assert.match(read('../../client/src/pages/TeacherSchedules.jsx'), /do not need to upload it again for each reservation/) // kept on the Teacher upload card
})

// ---------- client wiring (source checks; UI not executed) ----------
test('CLIENT wiring: MIS Staff gets Teacher Schedules menu + route; Teacher keeps My Schedule; MIS Staff page has no upload form; search box for MIS/MIS Staff', () => {
  const layout = read('../../client/src/components/AppLayout.jsx')
  const menus = layout.match(/const MENUS = \{[\s\S]*?\n\}\n/)[0]
  const block = key => { const i = menus.indexOf(`${key}: [`); return menus.slice(i, menus.indexOf('\n  ],', i)) }
  assert.match(block("'Inventory Staff'"), /\/teacher-schedules/); assert.match(block('Teacher'), /'My Schedule', '\/teacher-schedules'/); assert.match(block('MIS'), /\/teacher-schedules/)
  const access = layout.match(/ROUTE_ACCESS = \{[\s\S]*?\n\}/)[0].split('\n'); const line = role => access.find(l => l.trim().startsWith(`${role}:`))
  for (const role of ['MIS', 'Teacher', "'Inventory Staff'"]) assert.match(line(role), /\/teacher-schedules/, role)
  const page = read('../../client/src/pages/TeacherSchedules.jsx')
  assert.match(page, /\{canUpload && <form/); assert.match(page, /canUpload = \['Teacher', 'Dean', 'Others'\]\.includes\(user\?\.role\)/) // CP162: no upload form for MIS
  assert.match(page, /\{viewAll && <div className="schedules-fields schedules-search">/); assert.match(page, /params: viewAll && searchTerm \? \{ search: searchTerm \}/)
  assert.doesNotMatch(page, /api\.put/) // CP128: api.delete is now used (schedule delete)
})
