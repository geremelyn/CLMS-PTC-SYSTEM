'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function loadController({ maintenance = {}, failOn = '', missingLinkedAsset = false } = {}) {
  const calls = []
  const current = { id: 5, status: 'PENDING', computer_id: 10, equipment_id: null, issue_description: 'Fan noise', maintenance_note: null, date_resolved: null, ...maintenance }
  const connection = {
    beginTransaction(callback) { calls.push('BEGIN'); callback(null) },
    commit(callback) { calls.push('COMMIT'); callback(null) },
    rollback(callback) { calls.push('ROLLBACK'); callback(null) },
    release() { calls.push('RELEASE') },
    query(sql, values, callback) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push({ sql: normalized, values: values || [] })
      if (normalized.startsWith('SELECT * FROM maintenance')) return callback(null, [current])
      if (normalized.startsWith('SELECT operational_status')) return callback(null, missingLinkedAsset ? [] : [{ operational_status: 'ACTIVE', condition: 'WORKING', condition_note: null }])
      if (normalized.startsWith('SELECT status, condition_note FROM equipment')) return callback(null, missingLinkedAsset ? [] : [{ status: 'WORKING', condition_note: null }])
      if (normalized.startsWith('INSERT INTO undo_actions')) return callback(null, { insertId: 91, affectedRows: 1 })
      if (normalized.startsWith('SELECT id FROM computers')) return callback(null, missingLinkedAsset ? [] : [{ id: 10 }])
      if (normalized.startsWith('SELECT id FROM equipment')) return callback(null, missingLinkedAsset ? [] : [{ id: 20 }])
      if (failOn && normalized.startsWith(failOn)) return callback(Object.assign(new Error('simulated database failure'), { code: 'ER_TEST_FAILURE' }))
      if (normalized.startsWith('UPDATE computers') || normalized.startsWith('UPDATE equipment') || normalized.startsWith('UPDATE maintenance')) return callback(null, { affectedRows: 1 })
      callback(new Error(`Unexpected SQL: ${normalized}`))
    }
  }
  const fakeDb = { getConnection(callback) { calls.push('GET_CONNECTION'); callback(null, connection) } }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/maintenanceController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakeDb; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  return { controller: require('../controllers/maintenanceController.js'), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('maintenance transition updates the linked computer and maintenance row in one transaction', async () => {
  const { controller, calls } = loadController()
  const response = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS', maintenance_note: 'Diagnosing' }, user: { id: 9, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 200)
  assert.ok(calls.indexOf('BEGIN') < calls.findIndex(call => typeof call === 'object' && call.sql.startsWith('SELECT id FROM computers')))
  assert.ok(calls.findIndex(call => typeof call === 'object' && call.sql.startsWith('SELECT id FROM computers')) < calls.findIndex(call => typeof call === 'object' && call.sql.startsWith('UPDATE computers')))
  assert.ok(calls.findIndex(call => typeof call === 'object' && call.sql.startsWith('UPDATE computers')) < calls.findIndex(call => typeof call === 'object' && call.sql.startsWith('UPDATE maintenance')))
  assert.ok(calls.includes('COMMIT'))
  assert.ok(!calls.includes('ROLLBACK'))
})

test('maintenance update rolls back linked asset changes when the maintenance row update fails', async () => {
  const { controller, calls } = loadController({ failOn: 'UPDATE maintenance' })
  const response = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS', maintenance_note: 'Diagnosing' }, user: { id: 9, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 500)
  assert.match(response.body.message, /No changes were saved/i)
  assert.ok(calls.some(call => typeof call === 'object' && call.sql.startsWith('UPDATE computers')))
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.includes('COMMIT'))
})

test('maintenance transition rules reject invalid transitions before linked asset writes', async () => {
  const { controller, calls } = loadController({ maintenance: { status: 'PENDING' } })
  const response = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'COMPLETED', final_condition: 'WORKING' }, user: { id: 9, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 400)
  assert.match(response.body.message, /Cannot change maintenance from PENDING to COMPLETED/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(call => typeof call === 'object' && call.sql.startsWith('UPDATE computers')))
})

test('maintenance update validates IDs, final condition, and note size before acquiring a connection', async () => {
  const { controller, calls } = loadController()
  const invalidId = responseMock()
  await controller.updateMaintenance({ params: { id: '0' }, body: { status: 'PENDING' }, user: { id: 9 } }, invalidId)
  assert.equal(invalidId.code, 400)
  const invalidCondition = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'COMPLETED', final_condition: '' }, user: { id: 9 } }, invalidCondition) // CP112: a well-formed but unsaved name is now judged against the saved custom list (see maintenanceCustomConditionCp112.test.js)
  assert.equal(invalidCondition.code, 400)
  const oversizedNote = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'PENDING', maintenance_note: 'x'.repeat(2001) }, user: { id: 9 } }, oversizedNote)
  assert.equal(oversizedNote.code, 400)
  assert.ok(!calls.includes('GET_CONNECTION'))
})


test('maintenance update refuses a missing linked asset and rolls back before status change', async () => {
  const { controller, calls } = loadController({ missingLinkedAsset: true })
  const response = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS', maintenance_note: 'Diagnosing' }, user: { id: 9, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /linked computer no longer exists/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(call => typeof call === 'object' && call.sql.startsWith('UPDATE computers')))
  assert.ok(!calls.some(call => typeof call === 'object' && call.sql.startsWith('UPDATE maintenance')))
})

const longText = 'Screen flickers and shuts down randomly. '.repeat(20) // ~820 characters
test('IN PROGRESS saves even when the issue description is longer than the 255-char condition_note column (computer)', async () => {
  const { controller, calls } = loadController({ maintenance: { issue_description: longText } }), response = responseMock()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS', maintenance_note: 'Diagnosing' }, user: { id: 1, role: 'MIS' } }, response)
  assert.equal(response.code, 200, JSON.stringify(response.body))
  const asset = calls.find(c => c.sql?.startsWith('UPDATE computers')); assert.ok(asset.values[0].length <= 255, `condition_note was ${asset.values[0].length} chars`)
  assert.ok(calls.includes('COMMIT')); assert.ok(response.body.undoActionId)
})
test('IN PROGRESS saves for equipment with a long description; COMPLETED with a 2000-char note also fits', async () => {
  const eq = loadController({ maintenance: { computer_id: null, equipment_id: 20, issue_description: longText } }), r1 = responseMock()
  await eq.controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS' }, user: { id: 9, role: 'Inventory Staff' } }, r1)
  assert.equal(r1.code, 200); assert.ok(eq.calls.find(c => c.sql?.startsWith('UPDATE equipment')).values[0].length <= 255)
  const done = loadController({ maintenance: { status: 'IN PROGRESS' } }), r2 = responseMock()
  await done.controller.updateMaintenance({ params: { id: '5' }, body: { status: 'COMPLETED', final_condition: 'DAMAGED', maintenance_note: 'x'.repeat(2000) }, user: { id: 1, role: 'MIS' } }, r2)
  assert.equal(r2.code, 200, JSON.stringify(r2.body)); assert.ok(done.calls.find(c => c.sql?.startsWith('UPDATE computers')).values[2].length <= 255)
})
test('Others maintenance status saves as IN PROGRESS plus the custom label; blank label is rejected', async () => {
  const ok = loadController(), r1 = responseMock()
  await ok.controller.updateMaintenance({ params: { id: '5' }, body: { status: 'OTHERS', status_other: 'Waiting for parts' }, user: { id: 1, role: 'MIS' } }, r1)
  assert.equal(r1.code, 200); const upd = ok.calls.find(c => c.sql?.startsWith('UPDATE maintenance SET status')); assert.deepEqual(upd.values.slice(0, 2), ['IN PROGRESS', 'Waiting for parts'])
  const bad = loadController(), r2 = responseMock()
  await bad.controller.updateMaintenance({ params: { id: '5' }, body: { status: 'OTHERS', status_other: '  ' }, user: { id: 1, role: 'MIS' } }, r2)
  assert.equal(r2.code, 400)
})
test('maintenance update and undo routes allow exactly MIS and Inventory Staff', () => {
  const byRoute = {}, order = []
  const rp = path.resolve(__dirname, '../middleware/roleAuth.js'); const m = new Module(rp); m.filename = rp; m.loaded = true
  m.exports = { requireRole: (...roles) => { order.push(roles); return (q, s, n) => n() } }; require.cache[rp] = m
  const routes = path.resolve(__dirname, '../routes/maintenanceRoutes.js'); delete require.cache[routes]
  const router = require(routes)
  router.stack.filter(l => l.route).forEach((layer, i) => { byRoute[`${Object.keys(layer.route.methods)[0]} ${layer.route.path}`] = order[i] })
  assert.deepEqual(byRoute['put /:id'], ['MIS', 'Inventory Staff'])
  assert.deepEqual(byRoute['post /undo/:undoId'], ['MIS', 'Inventory Staff'])
  assert.deepEqual(byRoute['post /'], ['Teacher', 'Dean', 'Others'], 'creating a report is Teacher/Dean/custom roles only (CP85)')
  delete require.cache[rp]
})
