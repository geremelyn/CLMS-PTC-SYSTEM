const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function setup({ labExists = true, tagTaken = false, snapshot, capacity = 50, used = 0 } = {}) {
  const calls = []
  const snap = snapshot || { id: 9, computer_name: 'PC-01', laboratory_id: 2, asset_tag: 'AT-1', serial_number: 'SN-1', processor: null, ram: null, storage_capacity: null, storage_unit: null, storage_type: null, operational_status: 'ACTIVE', condition: 'WORKING', condition_note: null }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push(n)
      if (n.startsWith("SELECT id, snapshot_json FROM recycle_bin WHERE entity_type = 'computers'")) return cb(null, [{ id: 5, snapshot_json: JSON.stringify(snap) }])   // CP181 pre-lock
      if (n.startsWith('SELECT capacity FROM laboratories')) return cb(null, labExists ? [{ capacity }] : [])
      if (n.startsWith('SELECT COUNT(*) AS registeredComputers FROM computers')) return cb(null, [{ registeredComputers: used }])
      if (n.startsWith('SELECT * FROM recycle_bin')) return cb(null, [{ id: 5, entity_type: 'computers', entity_id: 9, label: 'PC-01', snapshot_json: JSON.stringify(snap), restored_at: null }])
      if (n.startsWith('SELECT id FROM computers WHERE id = ?')) return cb(null, [])
      if (n.startsWith('SELECT id FROM laboratories')) return cb(null, labExists ? [{ id: 2 }] : [])
      if (/^SELECT id FROM (computers|equipment) WHERE `(asset_tag|serial_number)`/.test(n)) return cb(null, tagTaken ? [{ id: 1 }] : [])
      if (n.startsWith('INSERT INTO computers')) return cb(null, { affectedRows: 1 })
      if (n.startsWith('UPDATE recycle_bin SET restored_at')) return cb(null, { affectedRows: 1 })
      throw new Error(`Unexpected SQL: ${n}`)
    }
  }
  stub('../database/db.js', { getConnection: cb => cb(null, connection), query: (s, v, cb) => cb(null, []) })
  stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../controllers/bulkRecordController.js')]
  delete require.cache[path.resolve(__dirname, '../controllers/recycleBinController.js')]
  return { controller: require('../controllers/recycleBinController.js'), calls }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
test('restore re-inserts the snapshot, marks it restored and commits', async () => {
  const { controller, calls } = setup(), r = res()
  await controller.restoreRecycleItem({ params: { id: '5' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body))
  assert.ok(calls.some(c => c.startsWith('INSERT INTO computers')) && calls.some(c => c.startsWith('UPDATE recycle_bin SET restored_at')) && calls.includes('COMMIT'))
})
test('restore is refused and rolled back when the parent laboratory no longer exists', async () => {
  const { controller, calls } = setup({ labExists: false }), r = res()
  await controller.restoreRecycleItem({ params: { id: '5' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 409); assert.match(r.body.message, /laboratory/i)
  assert.ok(calls.includes('ROLLBACK') && !calls.some(c => c.startsWith('INSERT INTO computers')))
})
test('restore is refused when the asset tag has since been reused', async () => {
  const { controller, calls } = setup({ tagTaken: true }), r = res()
  await controller.restoreRecycleItem({ params: { id: '5' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 409); assert.ok(calls.includes('ROLLBACK'))
})
test('Recycle Bin routes are restricted to MIS only', () => {
  const seen = []
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => { seen.push(roles); return (q, s, n) => n() } })
  delete require.cache[path.resolve(__dirname, '../routes/recycleBinRoutes.js')]
  require('../routes/recycleBinRoutes.js')
  assert.ok(seen.length >= 3 && seen.every(roles => roles.length === 1 && roles[0] === 'MIS'), 'every Recycle Bin route must be MIS-only')
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
})
