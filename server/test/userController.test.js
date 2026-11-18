'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function loadController({ selectRows = [], updateResult = { affectedRows: 1 }, sqlError = null } = {}) {
  const calls = []
  const fakeDb = {
    query(sql, values, callback) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values || [] })
      if (sql.startsWith('SELECT id FROM users WHERE username=')) return callback(null, selectRows)
      if (sql.startsWith('UPDATE users SET full_name=')) return callback(sqlError, updateResult)
      return callback(new Error(`Unexpected SQL: ${sql}`))
    }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/userController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakeDb; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (request === 'bcrypt') return { hash: async value => `hash:${value}`, compare: async () => true }
    return originalLoad.call(this, request, parent, isMain)
  }
  try { return { controller: require('../controllers/userController.js'), calls } }
  finally { Module._load = originalLoad }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

const teacherUpdate = { full_name: 'Teacher One', username: 'T001', role: 'Teacher', program: 'BSIT' }

test('promoting an existing account to Teacher re-enables must-change-password', () => {
  const { controller, calls } = loadController()
  const response = responseMock()
  controller.updateUser({ params: { id: '7' }, body: teacherUpdate, user: { id: 1, role: 'MIS' } }, response)
  assert.equal(response.code, 200)
  const update = calls[1]
  assert.match(update.sql, /must_change_password=CASE WHEN role != \? AND \? IN \('Dean','Teacher','Others'\) THEN 1 ELSE must_change_password END/)
  assert.deepEqual(update.values, ['Teacher One', 'T001', 'Teacher', 'Teacher', 'Teacher', 'Teacher', 'BSIT', null, null, null, null, 7])
})

test('editing an account already in a role does not unconditionally reset its password-change flag', () => {
  const { controller, calls } = loadController()
  const response = responseMock()
  controller.updateUser({ params: { id: '7' }, body: teacherUpdate, user: { id: 1, role: 'MIS' } }, response)
  assert.equal(response.code, 200)
  assert.match(calls[1].sql, /ELSE must_change_password END/)
  assert.doesNotMatch(calls[1].sql, /must_change_password=1\s*,\s*role=/)
})

test('invalid user IDs and invalid role/program combinations are rejected before SQL', () => {
  const { controller, calls } = loadController()
  const invalidId = responseMock()
  controller.updateUser({ params: { id: '-1' }, body: teacherUpdate, user: { id: 1, role: 'MIS' } }, invalidId)
  assert.equal(invalidId.code, 400)
  const invalidRole = responseMock()
  controller.updateUser({ params: { id: '7' }, body: { ...teacherUpdate, role: 'Unknown Role' }, user: { id: 1, role: 'MIS' } }, invalidRole)
  assert.equal(invalidRole.code, 400)
  assert.equal(calls.length, 0)
})
