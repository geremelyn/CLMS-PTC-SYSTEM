const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const snapshot = { id: 1, computer_name: 'PC-1', laboratory_id: 1, asset_tag: 'TAG-1', serial_number: 'SN-1', processor: 'Intel i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING', condition_note: '' }
function loadController({ linked = false, duplicateRestore = false, duplicateRestoreAt = 0, snapshotCount = 1 } = {}) {
  const calls = []
  let duplicateChecks = 0
  const connection = {
    beginTransaction(callback) { calls.push('BEGIN'); callback(null) }, commit(callback) { calls.push('COMMIT'); callback(null) }, rollback(callback) { calls.push('ROLLBACK'); callback(null) }, release() { calls.push('RELEASE') },
    query(sql, values, callback) {
      const normalized = sql.replace(/\s+/g, ' ').trim(); calls.push(normalized)
      if (normalized.startsWith('SELECT * FROM computers')) return callback(null, [snapshot])
      if (normalized.startsWith('SELECT DISTINCT computer_id AS id FROM equipment')) return callback(null, linked ? [{ id: 1 }] : [])
      if (normalized.startsWith('SELECT DISTINCT computer_id AS id FROM maintenance')) return callback(null, [])
      if (normalized.startsWith('SELECT id FROM equipment WHERE computer_id')) return callback(null, linked ? [{ id: 5 }] : [])
      if (normalized.startsWith('SELECT id FROM maintenance WHERE computer_id')) return callback(null, [])
      if (normalized.startsWith('INSERT INTO recycle_bin') || normalized.startsWith('UPDATE recycle_bin SET restored_at')) return callback(null, { affectedRows: 1, insertId: 1 })
      if (normalized.startsWith('INSERT INTO undo_actions')) return callback(null, { insertId: 77, affectedRows: 1 })
      if (normalized.startsWith('DELETE FROM computers')) return callback(null, { affectedRows: 1 })
      if (normalized.startsWith('SELECT id, entity_type, snapshot_json')) { const records = Array.from({ length: snapshotCount }, (_, index) => ({ ...snapshot, id: index + 1, computer_name: `PC-${index + 1}`, asset_tag: `TAG-${index + 1}`, serial_number: `SN-${index + 1}` })); return callback(null, [{ id: 77, entity_type: 'computers', snapshot_json: JSON.stringify(records), created_by: 3, used_at: null, expires_at: '2026-10-27 12:10:00', seconds_since_created: 60 }]) }
      if (normalized.startsWith('SELECT id FROM computers WHERE (asset_tag')) { duplicateChecks++; return callback(null, duplicateRestore || duplicateChecks === duplicateRestoreAt ? [{ id: 99 }] : []) }
      if (normalized.startsWith('SELECT id FROM equipment WHERE (asset_tag')) return callback(null, [])
      if (normalized.startsWith('INSERT INTO computers (`id`')) return callback(null, { affectedRows: 1 })
      if (normalized.startsWith('UPDATE undo_actions SET used_at')) return callback(null, { affectedRows: 1 })
      throw new Error(`Unexpected mock SQL: ${normalized}`)
    }
  }
  const fakeDb = { getConnection(callback) { callback(null, connection) }, query(sql, values, callback) { if (typeof values === 'function') callback = values; if (callback) callback(null, { affectedRows: 1, insertId: 1 }) } }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), controllerPath = path.resolve(__dirname, '../controllers/bulkRecordController.js')
  const fakeModule = new Module(dbPath); fakeModule.filename = dbPath; fakeModule.loaded = true; fakeModule.exports = fakeDb; require.cache[dbPath] = fakeModule
  delete require.cache[auditPath]; delete require.cache[controllerPath]
  const { createBulkRecordController } = require('../controllers/bulkRecordController.js')
  return { actions: createBulkRecordController('computers'), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('bulk delete snapshots and deletes selected records in one transaction', async () => {
  const { actions, calls } = loadController(); const response = responseMock()
  await actions.bulkDelete({ body: { ids: [1] }, user: { id: 3, role: 'MIS' } }, response)
  assert.equal(response.code, 200); assert.equal(response.body.undoActionId, 77)
  assert.ok(calls.includes('BEGIN')); assert.ok(calls.includes('COMMIT')); assert.ok(!calls.includes('ROLLBACK'))
  assert.ok(calls.some(call => call.startsWith('INSERT INTO undo_actions'))); assert.ok(calls.some(call => call.startsWith('INSERT INTO recycle_bin')), 'deleted records must be copied to the Recycle Bin in the same transaction'); assert.ok(calls.some(call => call.startsWith('DELETE FROM computers')))
})
test('bulk delete refuses linked computers and rolls back without deleting', async () => {
  const { actions, calls } = loadController({ linked: true }); const response = responseMock()
  await actions.bulkDelete({ body: { ids: [1] }, user: { id: 3, role: 'MIS' } }, response)
  assert.equal(response.code, 409); assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(call => call.startsWith('DELETE FROM computers')))
})
test('bulk undo restores the saved record and consumes the undo action transactionally', async () => {
  const { actions, calls } = loadController(); const response = responseMock()
  await actions.undoDelete({ params: { undoId: '77' }, user: { id: 3, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 200); assert.equal(response.body.restoredCount, 1)
  assert.ok(calls.includes('COMMIT')); assert.ok(calls.some(call => call.startsWith('INSERT INTO computers (`id`'))); assert.ok(calls.some(call => call.startsWith('UPDATE undo_actions SET used_at')))
})
test('bulk undo rolls back the whole restore when an identifier was reused', async () => {
  const { actions, calls } = loadController({ duplicateRestore: true }); const response = responseMock()
  await actions.undoDelete({ params: { undoId: '77' }, user: { id: 3, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 409); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})

test('bulk undo rolls back an earlier restored row if a later snapshot row collides', async () => {
  const { actions, calls } = loadController({ duplicateRestoreAt: 2, snapshotCount: 2 }); const response = responseMock()
  await actions.undoDelete({ params: { undoId: '77' }, user: { id: 3, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 409)
  assert.equal(calls.filter(call => call.startsWith('INSERT INTO computers (`id`')).length, 1, 'the first insert was attempted before the second row collided')
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.includes('COMMIT'))
})

test('Delete All (skipLinked) deletes unlinked records and reports zero skipped', async () => {
  const { actions, calls } = loadController(); const response = responseMock()
  await actions.bulkDelete({ body: { ids: [1], skipLinked: true }, user: { id: 3, role: 'MIS' } }, response)
  assert.equal(response.code, 200); assert.equal(response.body.deletedCount, 1); assert.equal(response.body.skippedCount, 0)
  assert.ok(calls.includes('COMMIT') && calls.some(c => c.startsWith('DELETE FROM computers')))
})
test('Delete All (skipLinked) refuses and deletes nothing when every record is still linked', async () => {
  const { actions, calls } = loadController({ linked: true }); const response = responseMock()
  await actions.bulkDelete({ body: { ids: [1], skipLinked: true }, user: { id: 3, role: 'MIS' } }, response)
  assert.equal(response.code, 409); assert.match(response.body.message, /referenced/)
  assert.ok(calls.includes('ROLLBACK') && !calls.some(c => c.startsWith('DELETE FROM computers')))
})
