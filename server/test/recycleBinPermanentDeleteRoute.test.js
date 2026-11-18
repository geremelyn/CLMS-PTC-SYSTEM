'use strict'
// Route / permission tests for POST /recycle-bin/permanent-delete (stub express + stub database; not MySQL).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })

test('the permanent-delete route is registered and protected by requireRole("MIS") only', () => {
  const registered = []
  const router = { get: (...a) => registered.push(['GET', ...a]), post: (...a) => registered.push(['POST', ...a]) }
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => Object.assign(() => {}, { roles }) })
  stub('../controllers/recycleBinController.js', { listRecycleBin() {}, restoreRecycleItem() {}, restoreRecycleItems() {}, permanentDeleteRecycleItems() {} })
  const expressPath = require.resolve('express'); const original = require.cache[expressPath]
  const fakeExpress = Object.assign(() => ({}), { Router: () => router }); stub(expressPath, fakeExpress)
  try { delete require.cache[path.resolve(__dirname, '../routes/recycleBinRoutes.js')]; require('../routes/recycleBinRoutes.js') } finally { if (original) require.cache[expressPath] = original; else delete require.cache[expressPath] }
  const route = registered.find(r => r[0] === 'POST' && r[1] === '/permanent-delete'); assert.ok(route, 'route registered')
  assert.deepEqual(route[2].roles, ['MIS'], 'only MIS'); assert.equal(typeof route[3], 'function')
  const restoreIndex = registered.findIndex(r => r[1] === '/:id/restore'), permIndex = registered.findIndex(r => r[1] === '/permanent-delete')
  assert.ok(permIndex < restoreIndex, 'registered before the /:id routes')
})

test('the real requireRole("MIS") gate lets MIS through and turns away Inventory Staff, Dean and Teacher (403) and unauthenticated calls (401)', async () => {
  const { createSessionToken } = require('../utils/sessionToken.js')
  const roles = { Teacher: 7, Dean: 8, 'Inventory Staff': 2, MIS: 1 }
  stub('../database/db.js', { query(sql, values, cb) { if (/session_revocations/.test(sql)) return cb(null, []); const id = Number(values[0]); const role = Object.keys(roles).find(name => roles[name] === id); cb(null, [{ id, full_name: role, username: role, role, status: 'ACTIVE' }]) } })
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
  const { requireRole } = require('../middleware/roleAuth.js'); const gate = requireRole('MIS')
  const run = token => new Promise(resolve => { const r = res(); const json = r.json.bind(r); r.json = body => { json(body); resolve({ r, passed: false }); return r }; gate({ header: name => (name === 'authorization' && token ? `Bearer ${token}` : '') }, r, () => resolve({ r, passed: true })) })
  assert.equal((await run(null)).r.code, 401)
  for (const [role, id] of Object.entries(roles)) { const out = await run(createSessionToken(id)); assert.equal(out.passed, role === 'MIS', role); if (role !== 'MIS') assert.equal(out.r.code, 403, role) }
})
