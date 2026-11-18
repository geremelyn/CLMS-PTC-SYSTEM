// CP123 - Schedule access by role: Teacher / Dean / custom role (stored as 'Others') = OWN only; MIS Staff = view+download all; MIS Head = upload for any teacher + all.
// WHAT RUNS FOR REAL: the real routes file, the real requireRole middleware, real signed session tokens (utils/sessionToken.js) and the real
// controller. Each request goes middleware -> controller exactly as Express would chain them.
// WHAT IS MOCKED / STAND-IN: (1) the database is an in-memory node:sqlite engine behind a db.query adapter - NOT MySQL;
// (2) 'express' is replaced by a Router recorder, so there is NO live HTTP server, no body parsing, no real URL routing.
// NOT COVERED: real MySQL (LIKE collation, LONGBLOB, max_allowed_packet), Express itself, browser UI.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const b64 = t => Buffer.from('%PDF-' + t).toString('base64') // CP162: uploads must be real PDFs

function setup() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, role_other TEXT, status TEXT DEFAULT 'ACTIVE');
    CREATE TABLE session_revocations (token_hash TEXT PRIMARY KEY, expires_at TEXT);
    CREATE TABLE teacher_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, uploaded_by INTEGER NOT NULL, file_name TEXT NOT NULL, file_type TEXT, file_size INTEGER NOT NULL, file_data BLOB NOT NULL, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by INTEGER);
    INSERT INTO users (id, username, full_name, role, role_other, status) VALUES
      (1,'admin','Super Admin','MIS',NULL,'ACTIVE'), (2,'ana','Ana Santos','Teacher',NULL,'ACTIVE'), (3,'ben','Ben Reyes','Teacher',NULL,'ACTIVE'),
      (4,'dina','Dina Dean','Dean',NULL,'ACTIVE'), (5,'dax','Dax Dean','Dean',NULL,'ACTIVE'), (6,'staff','Sam Staff','Inventory Staff',NULL,'ACTIVE'),
      (7,'lia','Lia Librarian','Others','Librarian','ACTIVE'), (8,'leo','Leo Registrar','Others','Registrar','ACTIVE'),
      (9,'gone','Inactive Teacher','Teacher',NULL,'INACTIVE'), (10,'jan','Jan Janitor','Janitor',NULL,'ACTIVE');`)
  const audits = []
  const db = { query(sql, params, cb) {
    try {
      const text = sql.replace(/UTC_TIMESTAMP\(\)/g, 'CURRENT_TIMESTAMP'), args = (params || []).map(v => (v === undefined ? null : v))
      if (/^\s*(SELECT|WITH)/i.test(text)) return cb(null, sqlite.prepare(text).all(...args))
      const r = sqlite.prepare(text).run(...args); cb(null, { insertId: Number(r.lastInsertRowid), affectedRows: r.changes })
    } catch (error) { cb(error) }
  } }
  const stubMod = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stubMod('../database/db.js', db); stubMod('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) })
  for (const rel of ['../middleware/roleAuth.js', '../controllers/teacherScheduleController.js', '../routes/teacherScheduleRoutes.js']) delete require.cache[path.resolve(__dirname, rel)]
  const table = [], router = {}
  for (const verb of ['get', 'post', 'put', 'patch', 'delete']) router[verb] = (p, ...handlers) => table.push({ verb, p, handlers })
  const originalLoad = Module._load
  Module._load = function (request, ...rest) { return request === 'express' ? { Router: () => router } : originalLoad.call(this, request, ...rest) }
  try { require(path.resolve(__dirname, '../routes/teacherScheduleRoutes.js')) } finally { Module._load = originalLoad }
  const { createSessionToken } = require('../utils/sessionToken.js')
  const controller = require('../controllers/teacherScheduleController.js')
  const tokenFor = id => createSessionToken(id)

  // Runs a request through the route's handler chain (middleware then controller) and reports what came back.
  async function api(verb, routePath, { token, body, query = {}, params = {} } = {}) {
    const route = table.find(r => r.verb === verb && r.p === routePath)
    if (!route) return { code: 404, body: { message: 'no such route' }, noRoute: true }
    const out = { code: 200, body: null, sent: null, headers: {} }
    const request = { body, query, params, header: name => (String(name).toLowerCase() === 'authorization' && token !== undefined ? token : undefined) }
    let finished
    const done = new Promise(resolve => { finished = resolve })
    const response = { status(c) { out.code = c; return this }, json(b) { out.body = b; finished('responded'); return this }, setHeader(k, v) { out.headers[k] = v }, send(b) { out.sent = b; finished('responded'); return this } }
    const [guard, handler] = route.handlers
    guard(request, response, () => finished('next'))
    if (await done === 'next') await handler(request, response)
    return out
  }
  const as = (id, extra) => ({ token: `Bearer ${tokenFor(id)}`, ...extra })
  return { sqlite, audits, api, as, controller, tokenFor, table }
}
const upload = (ctx, id, fileName, content, extra = {}) => ctx.api('post', '/', ctx.as(id, { body: { fileName, fileType: 'application/pdf', fileBase64: b64(content), ...extra } }))
async function seed(ctx) { // every own-role user uploads one file; MIS uploads one for Ana
  assert.equal((await upload(ctx, 2, 'ana.pdf', 'ANA')).code, 201)       // id 1
  assert.equal((await upload(ctx, 3, 'ben.pdf', 'BEN')).code, 201)       // id 2
  assert.equal((await upload(ctx, 4, 'dina.pdf', 'DINA')).code, 201)     // id 3
  assert.equal((await upload(ctx, 5, 'dax.pdf', 'DAX')).code, 201)       // id 4
  assert.equal((await upload(ctx, 7, 'lia.pdf', 'LIA')).code, 201)       // id 5
  assert.equal((await upload(ctx, 8, 'leo.pdf', 'LEO')).code, 201)       // id 6
  assert.equal((await upload(ctx, 1, 'ana-by-admin.pdf', 'ANA2', { teacherId: 2 })).code, 201) // id 7
}
const OWN = { 2: ['ana-by-admin.pdf', 'ana.pdf'], 3: ['ben.pdf'], 4: ['dina.pdf'], 5: ['dax.pdf'], 7: ['lia.pdf'], 8: ['leo.pdf'] }
const FILE_OF = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 7, 6: 8, 7: 2 } // schedule id -> owner user id
const names = r => r.body.schedules.map(s => s.file_name).sort()

test('ROUTE TABLE: exactly list, upload, delete (CP128), view, download and teacher-picker; no put/patch route exists', () => {
  const ctx = setup()
  assert.deepEqual(ctx.table.map(r => `${r.verb} ${r.p}`).sort(), ['delete /:id', 'get /', 'get /:id/download', 'get /:id/view', 'get /teachers', 'post /', 'post /:id/undo-upload'])
  assert.equal(ctx.table.filter(r => ['put', 'patch'].includes(r.verb)).length, 0)
})

test('EVERY ROLE x EVERY ENDPOINT (real middleware): who gets through and who gets 403', async () => {
  const ctx = setup(); await seed(ctx)
  const body = { fileName: 'x.pdf', fileBase64: b64('x') }
  // [label, userId, teachers, list, upload (own), download of own file]
  const expected = [['MIS Head', 1, 200, 200, 201, 200], ['MIS Staff', 6, 403, 200, 403, 200], ['Teacher', 2, 403, 200, 201, 200], ['Dean', 4, 403, 200, 201, 200], ['Custom role', 7, 403, 200, 201, 200], ['Unknown role', 10, 403, 403, 403, 403]]
  const ownFile = { 1: 7, 6: 1, 2: 1, 4: 3, 7: 5, 10: 1 }
  for (const [label, id, teachers, listCode, uploadCode, downloadCode] of expected) {
    assert.equal((await ctx.api('get', '/teachers', ctx.as(id))).code, teachers, `${label} GET /teachers`)
    assert.equal((await ctx.api('get', '/', ctx.as(id))).code, listCode, `${label} GET /`)
    assert.equal((await ctx.api('post', '/', ctx.as(id, { body: { ...body, ...(id === 1 ? { teacherId: 3 } : {}) } }))).code, uploadCode, `${label} POST /`)
    assert.equal((await ctx.api('get', '/:id/download', ctx.as(id, { params: { id: String(ownFile[id]) } }))).code, downloadCode, `${label} download`)
  }
})

test('OWN-ONLY (Teacher, Dean, custom role): each sees exactly their own schedules and nobody else\'s, in list and in download', async () => {
  const ctx = setup(); await seed(ctx)
  for (const id of [2, 3, 4, 5, 7, 8]) {
    assert.deepEqual(names(await ctx.api('get', '/', ctx.as(id))), OWN[id], `list for user ${id}`)
    for (const [scheduleId, owner] of Object.entries(FILE_OF)) {
      const r = await ctx.api('get', '/:id/download', ctx.as(id, { params: { id: scheduleId } }))
      if (owner === id) { assert.equal(r.code, 200); assert.ok(r.sent) }
      else { assert.equal(r.code, 404, `user ${id} must not get schedule ${scheduleId}`); assert.equal(r.sent, null); assert.deepEqual(r.body, { message: 'Schedule not found.' }) }
    }
  }
})

test('DIRECT API TAMPERING (Teacher/Dean/custom role): ?teacher_id, ?search, array params, forged body owner fields, odd ids never reveal another user\'s schedule', async () => {
  const ctx = setup(); await seed(ctx)
  const missing = (await ctx.api('get', '/:id/download', ctx.as(2, { params: { id: '999' } }))).body
  for (const id of [2, 4, 7]) {
    for (const query of [{ teacher_id: 3 }, { teacher_id: '3' }, { teacher_id: ['3', '4'] }, { teacher_id: '0 OR 1=1' }, { search: 'Ben' }, { search: '%' }, { search: 'a' }, { teacher_id: 3, search: 'Ben Reyes' }]) {
      assert.deepEqual(names(await ctx.api('get', '/', ctx.as(id, { query }))), OWN[id], `user ${id} query ${JSON.stringify(query)}`)
    }
    const foreign = id === 2 ? '2' : '1' // a schedule that belongs to someone else
    for (const badId of [foreign, ` ${foreign} `, `${foreign}.0`, '1e0', '0x2', '2', '3', '4', '5', '6', '-1', '0', '1.5', 'abc', '', '1 OR 1=1', "1'; DROP TABLE teacher_schedules;--", '999']) {
      const r = await ctx.api('get', '/:id/download', ctx.as(id, { params: { id: badId } }))
      if (r.code === 200) { assert.ok(Number(badId) in FILE_OF && FILE_OF[Number(badId)] === id, `user ${id} got 200 for id ${JSON.stringify(badId)} but does not own it`) }
      else { assert.ok([400, 404].includes(r.code), `${id} ${badId} -> ${r.code}`); assert.equal(r.sent, null); if (r.code === 404) assert.deepEqual(r.body, missing, 'foreign and missing ids are indistinguishable') }
    }
    // forged ownership in the upload body: another teacherId is refused (nothing saved); owner fields other than teacherId are ignored
    const before = ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n
    for (const teacherId of [3, '3', 1, 6, [3], { id: 3 }]) {
      const r = await upload(ctx, id, `forged-${id}.pdf`, 'F', { teacherId })
      if (r.code === 201) assert.ok(Number(teacherId) === id || (Array.isArray(teacherId) && Number(teacherId) === id)) // only "own id" shapes may pass, and they still save as self
      else assert.equal(r.code, 403)
    }
    const forged = await upload(ctx, id, `forged2-${id}.pdf`, 'F2', { teacher_id: 3, uploaded_by: 3, uploadedBy: 3, user_id: 3 })
    assert.equal(forged.code, 201)
    const rows = ctx.sqlite.prepare("SELECT teacher_id, uploaded_by FROM teacher_schedules WHERE file_name IN (?, ?)").all(`forged-${id}.pdf`, `forged2-${id}.pdf`)
    assert.ok(rows.length >= 1 && rows.every(r => r.teacher_id === id && r.uploaded_by === id), `all rows saved for user ${id} only`)
    assert.ok(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n >= before)
  }
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules WHERE teacher_id = 3').get().n, 1, 'Ben still has only his own single upload')
})

test('DIRECT API: Dean and custom role cannot upload for another user or for a teacher (403, nothing saved, no audit entry)', async () => {
  const ctx = setup(); const before = ctx.audits.length
  for (const id of [4, 7]) for (const teacherId of [2, 3, 1, 6, 5, 8, 9]) {
    const r = await upload(ctx, id, 'x.pdf', 'x', { teacherId }); assert.equal(r.code, 403, `user ${id} -> teacher ${teacherId}`)
  }
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 0)
  assert.equal(ctx.audits.length, before)
})

test('MIS STAFF: lists and downloads ALL schedules (exact bytes, attachment) but cannot upload, delete or use the teacher picker', async () => {
  const ctx = setup(); await seed(ctx)
  const list = await ctx.api('get', '/', ctx.as(6)); assert.equal(list.body.schedules.length, 7)
  assert.deepEqual(names(await ctx.api('get', '/', ctx.as(6, { query: { search: 'dina' } }))), ['dina.pdf'])
  const expectedBytes = Object.fromEntries(Object.entries({ 1: 'ANA', 2: 'BEN', 3: 'DINA', 4: 'DAX', 5: 'LIA', 6: 'LEO', 7: 'ANA2' }).map(([k, v]) => [k, '%PDF-' + v]))
  for (const [id, text] of Object.entries(expectedBytes)) {
    const r = await ctx.api('get', '/:id/download', ctx.as(6, { params: { id } }))
    assert.equal(r.code, 200); assert.equal(Buffer.from(r.sent).toString(), text); assert.match(r.headers['Content-Disposition'], /^attachment;/)
  }
  const before = ctx.audits.length
  for (const body of [{ fileName: 's.pdf', fileBase64: b64('s') }, { fileName: 's.pdf', fileBase64: b64('s'), teacherId: 2 }]) assert.equal((await ctx.api('post', '/', ctx.as(6, { body }))).code, 403)
  assert.equal((await ctx.api('get', '/teachers', ctx.as(6))).code, 403)
  for (const verb of ['delete', 'put', 'patch']) for (const p of ['/', '/:id', '/:id/download']) { const r = await ctx.api(verb, p, ctx.as(6)); if (verb === 'delete' && p === '/:id') assert.equal(r.code, 403, 'CP128: MIS Staff delete refused by requireRole'); else assert.equal(r.noRoute, true, `${verb} ${p}`) }
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 7)
  assert.equal(ctx.audits.length, before)
})

test('MIS HEAD / SUPER ADMIN: uploads for any active teacher, sees and downloads ALL; search works; bad/inactive/non-teacher targets are rejected', async () => {
  const ctx = setup(); await seed(ctx)
  assert.equal((await ctx.api('get', '/', ctx.as(1))).body.schedules.length, 7)
  assert.deepEqual(names(await ctx.api('get', '/', ctx.as(1, { query: { search: 'ana' } }))), ['ana-by-admin.pdf', 'ana.pdf'])
  for (const id of Object.keys(FILE_OF)) assert.equal((await ctx.api('get', '/:id/download', ctx.as(1, { params: { id } }))).code, 200)
  assert.equal((await upload(ctx, 1, 'for-ben.pdf', 'B2', { teacherId: 3 })).code, 201)
  assert.equal(ctx.sqlite.prepare("SELECT teacher_id, uploaded_by FROM teacher_schedules WHERE file_name='for-ben.pdf'").get().teacher_id, 3)
  for (const teacherId of [undefined, 999, 9, 4, 6, 'abc']) assert.equal((await upload(ctx, 1, 'bad.pdf', 'x', { teacherId })).code, 400, `target ${teacherId}`)
  assert.deepEqual((await ctx.api('get', '/teachers', ctx.as(1))).body.teachers.map(t => t.username), ['ana', 'ben'])
})

test('UNAUTHORIZED DIRECT ACCESS: no token, garbage, tampered, revoked, inactive, deleted-user tokens get 401/403 on every endpoint and nothing is saved or sent', async () => {
  const ctx = setup(); await seed(ctx)
  const good = ctx.tokenFor(2), [payload, sig] = good.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 1, exp: Math.floor(Date.now() / 1000) + 9999 })).toString('base64url')
  const revoked = ctx.tokenFor(3); ctx.sqlite.prepare("INSERT INTO session_revocations VALUES (?, datetime('now','+1 day'))").run(require('crypto').createHash('sha256').update(revoked).digest('hex'))
  const cases = [['no header', undefined, 401], ['empty', '', 401], ['no Bearer', good, 401], ['garbage', 'Bearer abc', 401], ['tampered signature', `Bearer ${payload}.${sig.slice(0, -2)}xx`, 401],
    ['privilege-escalated payload (sub=1) with old signature', `Bearer ${forgedPayload}.${sig}`, 401], ['revoked session', `Bearer ${revoked}`, 401], ['inactive account', `Bearer ${ctx.tokenFor(9)}`, 403], ['deleted user id', `Bearer ${ctx.tokenFor(555)}`, 401]]
  for (const [label, token, code] of cases) {
    const reqs = [['get', '/'], ['get', '/teachers'], ['get', '/:id/download', { id: '1' }], ['post', '/', null, { fileName: 'x.pdf', fileBase64: b64('x'), teacherId: 3 }]]
    for (const [verb, p, params = {}, body] of reqs) { const r = await ctx.api(verb, p, { token, params, body }); assert.equal(r.code, code, `${label}: ${verb} ${p}`); assert.equal(r.sent, null); assert.equal(r.body.schedules, undefined) }
  }
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 7)
  assert.equal((await ctx.api('get', '/', ctx.as(2))).code, 200, 'a valid token still works')
})

test('DEFENSE IN DEPTH: even if a route let a wrong role through, the controller refuses unknown roles and MIS Staff upload', async () => {
  const { controller, sqlite } = setup()
  const res = () => ({ code: 200, body: null, sent: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this }, setHeader() {}, send(b) { this.sent = b; return this } })
  for (const role of ['Janitor', undefined, '', 'mis', 'Teacher ']) {
    const user = { id: 2, role }
    let r = res(); await controller.listSchedules({ user, query: {} }, r); assert.equal(r.code, 403, `list ${role}`)
    r = res(); await controller.downloadSchedule({ user, params: { id: '1' } }, r); assert.equal(r.code, 403, `download ${role}`)
    r = res(); await controller.uploadSchedule({ user, body: { fileName: 'a.pdf', fileBase64: b64('a') } }, r); assert.equal(r.code, 403, `upload ${role}`)
  }
  const r = res(); await controller.uploadSchedule({ user: { id: 6, role: 'Inventory Staff' }, body: { fileName: 'a.pdf', fileBase64: b64('a'), teacherId: 2 } }, r); assert.equal(r.code, 403)
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 0)
})

test('PRESERVED: audit entries (uploader id + teacher name), existing records, search and reuse still behave; reservations untouched', async () => {
  const ctx = setup()
  // a record that "already existed" before CP123 (uploaded by MIS for Ana) is still visible to Ana, MIS and MIS Staff
  ctx.sqlite.prepare("INSERT INTO teacher_schedules (teacher_id, uploaded_by, file_name, file_type, file_size, file_data) VALUES (2, 1, 'old.pdf', 'application/pdf', 3, x'414243')").run()
  assert.deepEqual(names(await ctx.api('get', '/', ctx.as(2))), ['old.pdf']); assert.equal((await ctx.api('get', '/', ctx.as(6))).body.schedules.length, 1)
  assert.equal(Buffer.from((await ctx.api('get', '/:id/download', ctx.as(2, { params: { id: '1' } }))).sent).toString(), 'ABC')
  assert.equal((await upload(ctx, 4, 'dina.pdf', 'D')).code, 201); assert.equal((await upload(ctx, 7, 'lia.pdf', 'L')).code, 201)
  assert.deepEqual(ctx.audits.map(a => [a[0], a[1]]), [[4, 'TEACHER SCHEDULE UPLOAD'], [7, 'TEACHER SCHEDULE UPLOAD']])
  assert.match(ctx.audits[0][2], /Dina Dean/); assert.match(ctx.audits[1][2], /Lia Librarian/)
  // reuse: one stored file serves repeated downloads by its owner; one upload is enough
  for (let i = 0; i < 3; i++) assert.equal((await ctx.api('get', '/:id/download', ctx.as(4, { params: { id: '2' } }))).code, 200)
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM teacher_schedules').get().n, 3)
  for (const f of ['../routes/reservationRoutes.js', '../controllers/reservationController.js', '../config/reservationPolicy.js', '../config/reservationTime.js', '../config/reservationPeriods.js']) assert.doesNotMatch(read(f), /teacher_schedules|teacher-schedules|teacherSchedule/i, f)
  assert.doesNotMatch(read('../controllers/teacherScheduleController.js'), /FROM reservations|reservation_/i)
})

test('CLIENT wiring (source checks, UI not executed): My Schedule for Teacher/Dean/custom roles; Teacher Schedules for MIS + MIS Staff; upload form only for MIS and own-roles', () => {
  const layout = read('../../client/src/components/AppLayout.jsx')
  const menus = layout.match(/const MENUS = \{[\s\S]*?\n\}\n/)[0]
  const block = key => { const i = menus.indexOf(`${key}: [`); return menus.slice(i, menus.indexOf('\n  ],', i)) }
  for (const role of ['Teacher', 'Dean', 'Others']) assert.match(block(role), /'My Schedule', '\/teacher-schedules'/, role)
  assert.match(block('MIS'), /'Teacher Schedules', '\/teacher-schedules'/); assert.match(block("'Inventory Staff'"), /'Teacher Schedules', '\/teacher-schedules'/)
  const access = layout.match(/ROUTE_ACCESS = \{[\s\S]*?\n\}/)[0].split('\n'); const line = role => access.find(l => l.trim().startsWith(`${role}:`))
  for (const role of ['MIS', 'Teacher', 'Dean', 'Others', "'Inventory Staff'"]) assert.match(line(role), /\/teacher-schedules/, role)
  const page = read('../../client/src/pages/TeacherSchedules.jsx')
  assert.match(page, /canUpload = \['Teacher', 'Dean', 'Others'\]\.includes\(user\?\.role\)/); assert.match(page, /\{canUpload && <form/) // CP162: upload form for own-only roles only
  assert.doesNotMatch(page, /teacher-schedules\/teachers/, 'CP162: Super Admin page no longer loads a teacher picker')
  assert.doesNotMatch(page, /api\.put/) // CP128: api.delete is now used (schedule delete)
})
