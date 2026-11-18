const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function load({ age = 30, usedAt = null, createdBy = 4, currentStatus = 'IN PROGRESS', currentOther = null } = {}) {
  const calls = []
  const snap = { maintenance: { id: 5, status: 'PENDING', status_other: null, maintenance_note: null, date_resolved: null }, after: { status: 'IN PROGRESS', status_other: null }, asset: { table: 'computers', id: 10, fields: { operational_status: 'ACTIVE', condition: 'WORKING', condition_note: null } } }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: n, values })
      if (n.startsWith('SELECT id, entity_type, snapshot_json')) return cb(null, [{ id: 91, entity_type: 'maintenance', snapshot_json: JSON.stringify(snap), created_by: createdBy, used_at: usedAt, age }])
      if (n.startsWith('SELECT status, status_other FROM maintenance')) return cb(null, [{ status: currentStatus, status_other: currentOther }])
      if (/^UPDATE (maintenance|computers|equipment|undo_actions)/.test(n)) return cb(null, { affectedRows: 1 })
      cb(new Error('Unexpected SQL: ' + n))
    }
  }
  for (const [rel, exp] of [['../database/db.js', { getConnection: cb => cb(null, connection) }], ['../utils/auditLogger.js', { logAudit() {} }]]) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[path.resolve(__dirname, '../controllers/maintenanceController.js')]
  return { controller: require('../controllers/maintenanceController.js'), calls }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const req = { params: { undoId: '91' }, user: { id: 4, role: 'Inventory Staff' } }
test('maintenance undo restores the maintenance row and the asset condition', async () => {
  const { controller, calls } = load(), r = res()
  await controller.undoMaintenanceUpdate(req, r)
  assert.equal(r.code, 200)
  const upd = calls.filter(c => c.sql).map(c => c.sql)
  assert.ok(upd.some(q => q.startsWith('UPDATE maintenance SET status')) && upd.some(q => q.startsWith('UPDATE computers SET operational_status')) && upd.some(q => q.startsWith('UPDATE undo_actions SET used_at')) && calls.includes('COMMIT'))
  assert.deepEqual(calls.find(c => c.sql?.startsWith('UPDATE maintenance SET status')).values.slice(0, 2), ['PENDING', null])
})
test('maintenance undo is refused when already used, by another user, or after a later change', async () => {
  for (const [opts, code] of [[{ usedAt: '2026-01-01' }, 409], [{ createdBy: 99 }, 403], [{ currentStatus: 'COMPLETED' }, 409]]) {
    const { controller, calls } = load(opts), r = res()
    await controller.undoMaintenanceUpdate(req, r)
    assert.equal(r.code, code, JSON.stringify(opts)); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(c => c.sql?.startsWith('UPDATE maintenance SET status')))
  }
})

test('CP6: maintenance undo has NO 10-minute limit (still works 30 days later)', async () => {
  const { controller } = load({ age: 30 * 86400 }), r = res()
  await controller.undoMaintenanceUpdate(req, r)
  assert.equal(r.code, 200, JSON.stringify(r.body))
})
