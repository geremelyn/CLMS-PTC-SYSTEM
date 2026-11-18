// "Others" accounts: created ACTIVE, stored with their OWN role value (never Teacher), and they gain no Teacher permissions. MOCKED DB.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
function load() {
  const calls = []
  const db = { query(sql, values, cb) { const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: n, values }); if (n.startsWith('SELECT id FROM users')) return cb(null, []); if (n.startsWith('INSERT INTO users')) return cb(null, { insertId: 55 }); if (n.startsWith('INSERT IGNORE INTO custom_roles')) return cb(null, { affectedRows: 1 }); if (n.startsWith('SELECT role_name FROM custom_roles')) return cb(null, [{ role_name: values[0] }]); cb(new Error('Unexpected SQL ' + n)) } }
  for (const [rel, exp] of [['../database/db.js', db], ['../utils/auditLogger.js', { logAudit() {} }]]) { const p = path.resolve(__dirname, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp } }
  delete require.cache[path.resolve(__dirname, '../controllers/userController.js')]
  return { controller: require('../controllers/userController.js'), calls }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const create = async body => { const { controller, calls } = load(), r = res(); controller.createUser({ body, user: { id: 1, role: 'MIS' } }, r); await new Promise(resolve => setTimeout(resolve, 50)); return { r, calls } }
test('CP6: an "Others" account is created ACTIVE with role Others (not Teacher) and keeps its custom label', async () => {
  const { r, calls } = await create({ full_name: 'Maria Santos', username: 'msantos', password: 'Password123!', role: 'Others', role_other: 'Librarian' })
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.user.role, 'Others'); assert.equal(r.body.user.status, 'ACTIVE')
  const insert = calls.find(c => c.sql.startsWith('INSERT INTO users')); assert.ok(insert.values.includes('Others') && insert.values.includes('ACTIVE') && insert.values.includes('Librarian'))
  assert.ok(!insert.values.includes('Teacher'), 'must not inherit the Teacher role')
})
test('CP6: a Teacher account is still stored as Teacher/ACTIVE (Others handling did not change it)', async () => {
  const { r } = await create({ full_name: 'Juan Cruz', username: 'jcruz', password: 'Password123!', role: 'Teacher', program: 'BSIT' })
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.user.role, 'Teacher'); assert.equal(r.body.user.status, 'ACTIVE')
})
test('CP6: "Others" without a custom label is rejected', async () => { const { r } = await create({ full_name: 'X Y', username: 'xy', password: 'Password123!', role: 'Others', role_other: '' }); assert.equal(r.code, 400) })
// CP68 supersedes the CP6 'self-service only' rule: custom roles now get the Teacher-style lab reservation routes. The exact route allow-list
// (and everything they must NOT reach) is asserted in customRolePermissionsCp68.test.js.
test('CP9: editing an account to role Others sets status ACTIVE in the UPDATE statement; other roles keep their status', async () => {
  const run = async role => {
    const calls = []
    const db = { query(sql, values, cb) { const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: n, values }); if (n.startsWith('SELECT id FROM users')) return cb(null, []); if (n.startsWith('UPDATE users')) return cb(null, { affectedRows: 1 }); cb(null, []) } }
    for (const [rel, exp] of [['../database/db.js', db], ['../utils/auditLogger.js', { logAudit() {} }]]) { const p = path.resolve(__dirname, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp } }
    delete require.cache[path.resolve(__dirname, '../controllers/userController.js')]
    const r = res(); require('../controllers/userController.js').updateUser({ params: { id: '7' }, body: { full_name: 'Maria Santos', username: 'msantos', role, role_other: role === 'Others' ? 'Librarian' : null, program: role === 'Teacher' ? 'BSIT' : null }, user: { id: 1 } }, r)
    await new Promise(resolve => setTimeout(resolve, 30)); return { r, upd: calls.find(c => c.sql.startsWith('UPDATE users')) }
  }
  const o = await run('Others'); assert.equal(o.r.code, 200); assert.match(o.upd.sql, /status=CASE WHEN \? = 'Others' THEN 'ACTIVE' ELSE status END/); assert.equal(o.upd.values.filter(v => v === 'Others').length, 4); assert.ok(o.upd.values.includes('Librarian'))
  const t = await run('Teacher'); assert.equal(t.r.code, 200); assert.equal(t.upd.values.includes('Others'), false)
})
