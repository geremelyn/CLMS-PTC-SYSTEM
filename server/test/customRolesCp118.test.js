'use strict'
// CP118: User Accounts custom roles. A custom role is role 'Others' + a role name (role_other); a registry table (custom_roles) keeps the
// canonical spelling so duplicates are prevented and an unused role can be deleted.
// DATABASE-BACKED tests run the REAL userController SQL on an in-memory SQLITE database (node:sqlite) - NOT MySQL/MariaDB.
// "FOR UPDATE" locks are only stripped by the adapter, so row locking itself is NOT verified here. Route/permission tests use a route
// recorder and the real requireRole middleware with a mocked db. Source checks read client/src/pages/Users.jsx.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const { createSqliteDb, res } = require('./helpers/sqliteMysqlAdapter.js')
const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const ROOT = path.resolve(__dirname, '..', '..')

function setup({ failWhen } = {}) {
  const db = createSqliteDb({ failWhen }), s = db.sqlite, audits = []
  for (const col of ['role_other TEXT', 'surname TEXT', 'first_name TEXT', 'middle_initial TEXT', 'program TEXT', 'must_change_password INTEGER DEFAULT 0']) s.exec(`ALTER TABLE users ADD COLUMN ${col}`)
  s.exec('CREATE TABLE custom_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, role_name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
  s.exec("INSERT INTO users (id, username, full_name, role, status) VALUES (1,'admin','Super Admin','MIS','ACTIVE'),(2,'staff','MIS Staff','Inventory Staff','ACTIVE'),(3,'dean','Dean D','Dean','ACTIVE')")
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) })
  delete require.cache[path.resolve(__dirname, '../controllers/userController.js')]; delete require.cache[path.resolve(__dirname, '../utils/userValidation.js')]
  return { db, s, audits, c: require('../controllers/userController.js') }
}
const MIS = { id: 1, role: 'MIS' }
const send = (fn, { body = {}, params = {} } = {}) => new Promise(resolve => { const r = res(); const orig = r.json.bind(r); r.json = b => { orig(b); resolve({ code: r.code, body: r.body }); return r }; fn({ body, params, user: MIS }, r) })
const mk = (c, username, role_other, extra = {}) => send(c.createUser, { body: { full_name: `User ${username}`, username, password: 'Password123!', role: 'Others', role_other, ...extra } })
const rolesOf = s => s.prepare('SELECT role_name FROM custom_roles ORDER BY id').all().map(r => r.role_name)

test('ADD: choosing Custom/Others with a role name creates the account as role Others + that name, and registers the role', async () => {
  const { s, c } = setup()
  const r = await mk(c, 'u1', 'Librarian'); assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.user.role, 'Others'); assert.equal(r.body.user.role_other, 'Librarian')
  const row = s.prepare("SELECT role, role_other, status FROM users WHERE username='u1'").get(); assert.deepEqual({ ...row }, { role: 'Others', role_other: 'Librarian', status: 'ACTIVE' })
  assert.deepEqual(rolesOf(s), ['Librarian'])
})
test('ADD: a custom role needs a name (400, nothing saved); names over 100 characters are rejected', async () => {
  const { s, c } = setup()
  for (const bad of ['', '   ', 'x'.repeat(101)]) { const r = await mk(c, 'bad', bad); assert.equal(r.code, 400, JSON.stringify(bad)) }
  assert.equal(s.prepare("SELECT COUNT(*) n FROM users WHERE username='bad'").get().n, 0); assert.deepEqual(rolesOf(s), [])
})
test('DISPLAY: the saved role name is shown (list API, PDF/role label helper), never the word Others/Custom', async () => {
  const { c } = setup(); await mk(c, 'u1', 'Lab Aide')
  const list = await send((q, r) => c.getUsers(q, r)); assert.equal(list.code, 200)
  const u = list.body.users.find(x => x.username === 'u1'); assert.equal(u.role, 'Others'); assert.equal(u.role_other, 'Lab Aide')
  const { userRoleLabel } = await import(path.join(ROOT, 'client/src/utils/usersPdf.js')); assert.equal(userRoleLabel(u), 'Lab Aide')
  assert.equal(userRoleLabel({ role: 'Inventory Staff' }), 'MIS Staff')   // built-in label unchanged
})
test('DUPLICATE PREVENTION: the same role typed with other casing/extra spaces reuses ONE role with the stored spelling', async () => {
  const { s, c } = setup(); await mk(c, 'u1', 'Lab Aide'); await mk(c, 'u2', 'lab aide'); await mk(c, 'u3', '  LAB    AIDE ')
  assert.deepEqual(rolesOf(s), ['Lab Aide'])
  assert.deepEqual(s.prepare("SELECT DISTINCT role_other r FROM users WHERE role='Others'").all().map(x => x.r), ['Lab Aide'])
  const roles = await send(c.getCustomRoles); assert.deepEqual(roles.body.map(x => ({ n: x.role_name, c: x.user_count })), [{ n: 'Lab Aide', c: 3 }])
})
test('DUPLICATE PREVENTION: built-in role names/labels cannot be used as a custom role (400, no account, no role)', async () => {
  const { s, c } = setup()
  for (const name of ['Dean', 'teacher', 'MIS', 'Super Admin', 'MIS Staff', 'Inventory Staff', 'Others', 'Custom', 'MIS Head']) { const r = await mk(c, 'x' + name.length, name); assert.equal(r.code, 400, name); assert.match(r.body.message, /built-in role name/i) }
  assert.deepEqual(rolesOf(s), []); assert.equal(s.prepare("SELECT COUNT(*) n FROM users WHERE username LIKE 'x%'").get().n, 0)
})
test('EDIT: switching a user to Custom registers the role; switching away keeps the (now unassigned) role; other fields stay', async () => {
  const { s, c } = setup(); await send(c.createUser, { body: { full_name: 'Tea Cher', username: 't1', password: 'Password123!', role: 'Dean' } })
  const id = s.prepare("SELECT id FROM users WHERE username='t1'").get().id
  let r = await send(c.updateUser, { params: { id: String(id) }, body: { full_name: 'Tea Cher', username: 't1', role: 'Others', role_other: 'Registrar' } }); assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.deepEqual({ ...s.prepare('SELECT role, role_other FROM users WHERE id=?').get(id) }, { role: 'Others', role_other: 'Registrar' }); assert.deepEqual(rolesOf(s), ['Registrar'])
  r = await send(c.updateUser, { params: { id: String(id) }, body: { full_name: 'Tea Cher', username: 't1', role: 'Dean' } }); assert.equal(r.code, 200)
  assert.deepEqual({ ...s.prepare('SELECT role, role_other FROM users WHERE id=?').get(id) }, { role: 'Dean', role_other: null }); assert.deepEqual(rolesOf(s), ['Registrar'])
  assert.equal((await send(c.getCustomRoles)).body[0].user_count, 0)
})
test('DELETE: a custom role still assigned to users cannot be deleted (409, nothing changes)', async () => {
  const { s, c, audits } = setup(); await mk(c, 'u1', 'Librarian'); await mk(c, 'u2', 'librarian')
  const id = s.prepare('SELECT id FROM custom_roles').get().id
  const r = await send(c.deleteCustomRole, { params: { ref: String(id) } }); assert.equal(r.code, 409); assert.equal(r.body.user_count, 2); assert.match(r.body.message, /still assigned to 2 user accounts/)
  assert.deepEqual(rolesOf(s), ['Librarian']); assert.equal(s.prepare("SELECT COUNT(*) n FROM users WHERE role='Others'").get().n, 2); assert.ok(!audits.some(a => a[1] === 'CUSTOM ROLE DELETED'))
})
test('DELETE: an unassigned custom role is deleted (and audited); users/other roles are untouched; the name can be created again', async () => {
  const { s, c, audits } = setup(); await mk(c, 'u1', 'Librarian'); await mk(c, 'u2', 'Registrar')
  s.prepare("UPDATE users SET role='Dean', role_other=NULL WHERE username='u1'").run()
  const id = s.prepare("SELECT id FROM custom_roles WHERE role_name='Librarian'").get().id
  const r = await send(c.deleteCustomRole, { params: { ref: String(id) } }); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.deepEqual(rolesOf(s), ['Registrar'])
  assert.equal(s.prepare("SELECT COUNT(*) n FROM users").get().n, 5)   // 3 seeded + u1 + u2: no account removed
  assert.ok(audits.some(a => a[0] === 1 && a[1] === 'CUSTOM ROLE DELETED' && /Librarian/.test(a[2])))
  assert.equal((await mk(c, 'u3', 'Librarian')).code, 201); assert.deepEqual(rolesOf(s), ['Registrar', 'Librarian'])
})
test('DELETE: unknown role -> 404; invalid id -> 400; deleting twice -> second is 404', async () => {
  const { s, c } = setup(); await mk(c, 'u1', 'Temp'); s.prepare("UPDATE users SET role='Dean', role_other=NULL WHERE username='u1'").run()
  assert.equal((await send(c.deleteCustomRole, { params: { ref: '999' } })).code, 404); assert.equal((await send(c.deleteCustomRole, { params: { ref: '0' } })).code, 400); assert.equal((await send(c.deleteCustomRole, { params: { ref: '' } })).code, 400)
  const id = String(s.prepare('SELECT id FROM custom_roles').get().id)
  assert.equal((await send(c.deleteCustomRole, { params: { ref: id } })).code, 200); assert.equal((await send(c.deleteCustomRole, { params: { ref: id } })).code, 404)
})
test('DELETE: built-in roles are protected (403) by name or label, even in other casing; accounts and roles are unchanged', async () => {
  const { s, c } = setup(); await mk(c, 'u1', 'Librarian')
  for (const ref of ['Dean', 'teacher', 'Inventory%20Staff', 'MIS', 'MIS%20Staff', 'Super%20Admin', 'Others', 'Custom']) { const r = await send(c.deleteCustomRole, { params: { ref } }); assert.equal(r.code, 403, ref); assert.match(r.body.message, /Built-in roles cannot be deleted/) }
  assert.deepEqual(rolesOf(s), ['Librarian']); assert.equal(s.prepare("SELECT COUNT(*) n FROM users WHERE role IN ('MIS','Dean','Inventory Staff')").get().n, 3)
})
test('DELETE by role name works for an unassigned custom role (case-insensitive) and still refuses an assigned one', async () => {
  const { s, c } = setup(); await mk(c, 'u1', 'Librarian'); assert.equal((await send(c.deleteCustomRole, { params: { ref: 'librarian' } })).code, 409)
  s.prepare("UPDATE users SET role='Dean', role_other=NULL WHERE username='u1'").run(); assert.equal((await send(c.deleteCustomRole, { params: { ref: 'LIBRARIAN' } })).code, 200); assert.deepEqual(rolesOf(s), [])
})
test('DELETE is atomic: a failure while deleting rolls back (role kept) and reports 500 (real SQL rollback on SQLITE)', async () => {
  const { s, c, db } = setup(); await mk(c, 'u1', 'Temp'); s.prepare("UPDATE users SET role='Dean', role_other=NULL WHERE username='u1'").run()
  db.state.failWhen = sql => (sql.startsWith('DELETE FROM custom_roles') ? new Error('simulated failure') : null)
  const id = s.prepare('SELECT id FROM custom_roles').get().id; const r = await send(c.deleteCustomRole, { params: { ref: String(id) } })
  assert.equal(r.code, 500); assert.deepEqual(rolesOf(s), ['Temp'])
  db.state.failWhen = null; assert.equal((await send(c.deleteCustomRole, { params: { ref: String(id) } })).code, 200)   // transaction was closed cleanly
})
test('EXISTING ACCOUNTS: the schema backfill registers existing custom roles once (case-insensitive) and changes no account', () => {
  const { s } = setup(); s.exec("INSERT INTO users (username, full_name, role, role_other) VALUES ('a','A','Others','Librarian'),('b','B','Others','librarian'),('c','C','Others','Registrar'),('d','D','Teacher',NULL),('e','E','Others','  ')")
  const src = fs.readFileSync(path.join(__dirname, '../database/ensureSchema.js'), 'utf8'); const sql = src.match(/run\("(INSERT IGNORE INTO custom_roles[^"]+)"\)/)[1]
  const before = JSON.stringify(s.prepare('SELECT * FROM users ORDER BY id').all()); s.prepare(sql.replace(/^INSERT IGNORE/, 'INSERT OR IGNORE')).run()
  assert.deepEqual(rolesOf(s).sort(), ['Librarian', 'Registrar']); assert.equal(JSON.stringify(s.prepare('SELECT * FROM users ORDER BY id').all()), before)
  assert.match(src, /CREATE TABLE IF NOT EXISTS custom_roles[\s\S]*UNIQUE KEY uq_custom_roles_name \(role_name\)/)
})
test('PERMISSIONS (route recorder): custom-role list/delete routes are MIS-only; the existing user routes keep their MIS-only roles', () => {
  const { db } = setup(); stub('../middleware/roleAuth.js', { requireRole: (...roles) => Object.assign(() => {}, { roles }) })
  const p = path.resolve(__dirname, '../routes/userRoutes.js'); delete require.cache[p]; const router = require(p)
  const find = (m, route) => router.stack.find(l => l.route.path === route && l.route.methods[m]).route.stack.flatMap(h => h.roles || [])
  assert.deepEqual(find('get', '/custom-roles'), ['MIS']); assert.deepEqual(find('delete', '/custom-roles/:ref'), ['MIS'])
  assert.deepEqual(find('get', '/'), ['MIS']); assert.deepEqual(find('post', '/'), ['MIS']); assert.deepEqual(find('put', '/:id'), ['MIS'])
  assert.ok(router.stack.findIndex(l => l.route.path === '/custom-roles') < router.stack.findIndex(l => l.route.path === '/:id'), 'custom-role routes are registered before /:id')
})
test('PERMISSIONS (real requireRole, mocked db): MIS passes; MIS Staff, Dean, Teacher and Others users get 403 on the custom-role routes', async () => {
  let role = 'MIS'
  stub('../utils/sessionToken.js', { verifySessionToken: () => ({ userId: 5 }), tokenHash: () => 'h' })
  stub('../database/db.js', { query(sql, params, cb) { if (/session_revocations/.test(sql)) return cb(null, []); cb(null, [{ id: 5, full_name: 'X', username: 'x', role, status: 'ACTIVE' }]) } })
  const mp = path.resolve(__dirname, '../middleware/roleAuth.js'); delete require.cache[mp]; const { requireRole } = require(mp)
  const call = () => new Promise(resolve => { const r = { status(c) { this.code = c; return this }, json() { resolve(this.code) } }; requireRole('MIS')({ header: () => 'Bearer x' }, r, () => resolve('next')) })
  for (const [r, expected] of [['MIS', 'next'], ['Inventory Staff', 403], ['Dean', 403], ['Teacher', 403], ['Others', 403]]) { role = r; assert.equal(await call(), expected, r) }
})
test('UI (source, CP140): Others in the Role list opens a popup for the custom role name; saved roles are listed in the dropdown; no separate Custom Roles button/manager', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/Users.jsx'), 'utf8')
  assert.match(src, /<option value=\"Inventory Staff\">MIS Staff<\/option>[\s\S]{0,700}<option value=\"Others\">Others<\/option>/)
  assert.match(src, /picked === 'Others'[\s\S]{0,260}await askCustomRoleName\(/)
  assert.match(src, /await prompt\(text, \{ title: 'Custom role'/)
  assert.match(src, /api\.get\('\/users\/custom-roles'\)/); assert.match(src, /customRoles\.map\(item => <option key=\{item\.id\} value=\{`custom:\$\{item\.role_name\}`\}/)
  // empty / too long / built-in / already existing names are refused inside the popup
  assert.match(src, /cannot be empty/); assert.match(src, /100 characters or fewer/); assert.match(src, /is a built-in role name/); assert.match(src, /already exists/)
  // the separate manager button and popup are gone (the delete API itself is untouched)
  assert.doesNotMatch(src, />Custom Roles</); assert.doesNotMatch(src, /openCustomRoles|rolesOpen|custom-roles-card/); // CP141: the only api.delete to custom-roles is the per-role Delete in the existing form (see the CP141 tests below)
  assert.equal((src.match(/<option value=\"Others\">Others<\/option>/g) || []).length, 2, 'role dropdown + Program dropdown')
})

// ---- CP141: delete an unused custom role inside the existing User Accounts form; corrected description ----
test('UI (source, CP141): Delete is offered only for custom roles with user_count === 0, behind a danger confirmation, using DELETE /users/custom-roles/:ref', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/Users.jsx'), 'utf8')
  assert.match(src, /customRoles\.filter\(item => Number\(item\.user_count\) === 0\)\.map\(/, 'Delete rows are built only from user_count === 0')
  assert.match(src, /if \(!item \|\| Number\(item\.user_count\) !== 0 \|\| deletingRoleId !== null\) return/, 'handler refuses assigned roles / double clicks')
  assert.match(src, /await confirm\(`Delete the custom role[\s\S]{0,200}danger: true/)
  assert.match(src, /api\.delete\(`\/users\/custom-roles\/\$\{encodeURIComponent\(item\.id\)\}`\)/)
  assert.equal((src.match(/api\.delete\(`\/users\/custom-roles/g) || []).length, 1)
  assert.match(src, /status === 409/); assert.match(src, /await loadCustomRoles\(\)/)
  // still no separate manager button/popup, and the built-in role options are not given a Delete
  assert.doesNotMatch(src, />Custom Roles</); assert.doesNotMatch(src, /openCustomRoles|rolesOpen|custom-roles-card/)
  assert.doesNotMatch(src, /Delete[^\n]{0,40}(Dean|Teacher|MIS Staff)\b/)
})
test('UI (source, CP141): the custom-role note no longer says "sign in and change its password only" and describes the real permissions', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/Users.jsx'), 'utf8')
  assert.doesNotMatch(src, /change its password only/); assert.doesNotMatch(src, /can sign in and change/)
  assert.match(src, /Custom roles have no Teacher, Dean, MIS Staff or MIS Head permissions by default, but can use the reservation features currently permitted to Others\./)
})
test('backend (CP141): delete route is unchanged - MIS only, 409 when assigned, built-in names refused (server file text)', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'server/routes/userRoutes.js'), 'utf8')
  assert.match(routes, /router\.delete\('\/custom-roles\/:ref', requireRole\('MIS'\), deleteCustomRole\)/)
  const ctl = fs.readFileSync(path.join(ROOT, 'server/controllers/userController.js'), 'utf8')
  assert.match(ctl, /finish\(409,/); assert.match(ctl, /Built-in roles cannot be deleted/)
})
