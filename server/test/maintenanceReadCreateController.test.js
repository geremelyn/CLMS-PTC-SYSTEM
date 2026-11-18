'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function loadController({ selectError = null, insertError = null, listError = null } = {}) {
  const calls = []
  const fakeDb = {
    query(sql, values, callback) {
      if (typeof values === 'function') { callback = values; values = [] }
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values || [] })
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT maintenance.*')) return callback(listError, listError ? undefined : [])
      if (normalized.startsWith('SELECT id, laboratory_id, computer_name, asset_tag FROM computers')) {
        return callback(selectError, selectError ? undefined : [{ id: 10, laboratory_id: 2, computer_name: 'PC-2', asset_tag: 'TAG-10' }])
      }
      if (normalized.startsWith('INSERT INTO maintenance')) return callback(insertError, insertError ? undefined : { insertId: 99 })
      callback(new Error(`Unexpected SQL: ${normalized}`))
    }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/maintenanceController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakeDb; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  return { controller: require('../controllers/maintenanceController.js'), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('maintenance list returns a generic server error without exposing SQL details', () => {
  const { controller } = loadController({ listError: Object.assign(new Error('table secret_schema does not exist'), { code: 'ER_NO_SUCH_TABLE' }) })
  const response = responseMock()
  controller.getMaintenance({}, response)
  assert.equal(response.code, 500)
  assert.equal(response.body.message, 'Unable to retrieve maintenance records.')
  assert.doesNotMatch(response.body.message, /secret_schema|ER_NO_SUCH_TABLE/i)
})

test('maintenance creation rejects non-positive asset/laboratory IDs before SQL', () => {
  const { controller, calls } = loadController()
  const response = responseMock()
  controller.createMaintenance({ body: { computer_id: '-10', laboratory_id: '2', issue_description: 'Broken fan' }, user: { id: 4 } }, response)
  assert.equal(response.code, 400)
  assert.match(response.body.message, /positive whole numbers/i)
  assert.equal(calls.length, 0)
})

test('maintenance creation reports a generic asset-verification failure', () => {
  const { controller, calls } = loadController({ selectError: Object.assign(new Error('internal SQL table details'), { code: 'ER_BAD_FIELD_ERROR' }) })
  const response = responseMock()
  controller.createMaintenance({ body: { computer_id: 10, laboratory_id: 2, issue_description: 'Broken fan' }, user: { id: 4 } }, response)
  assert.equal(response.code, 500)
  assert.equal(response.body.message, 'Unable to verify the selected asset.')
  assert.doesNotMatch(response.body.message, /internal SQL|ER_BAD_FIELD_ERROR/i)
  assert.equal(calls.length, 1)
})

test('maintenance creation reports a generic insert failure', () => {
  const { controller } = loadController({ insertError: Object.assign(new Error('database table detail'), { code: 'ER_BAD_FIELD_ERROR' }) })
  const response = responseMock()
  controller.createMaintenance({ body: { computer_id: 10, laboratory_id: 2, issue_description: 'Broken fan' }, user: { id: 4 } }, response)
  assert.equal(response.code, 500)
  assert.equal(response.body.message, 'Unable to save maintenance report.')
  assert.doesNotMatch(response.body.message, /database table detail|ER_BAD_FIELD_ERROR/i)
})
