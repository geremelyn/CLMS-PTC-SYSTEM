'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function loadController({ duplicate = false } = {}) {
  const calls = []
  const options = []
  const fakeDb = {
    query(sql, values, callback) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.startsWith('SELECT id, category, value FROM lookup_options')) {
        return callback(null, options.filter(item => item.category === values[0]).map(item => ({ ...item })))
      }
      if (sql.startsWith('INSERT INTO lookup_options')) {
        const [category, value, createdBy] = values
        if (duplicate || options.some(item => item.category.toLowerCase() === category.toLowerCase() && item.value.toLowerCase() === value.toLowerCase())) {
          return callback(Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }))
        }
        const option = { id: options.length + 1, category, value, created_by: createdBy }
        options.push(option)
        return callback(null, { insertId: option.id, affectedRows: 1 })
      }
      callback(new Error('Unexpected SQL'))
    }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/lookupOptionController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakeDb; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  return { controller: require('../controllers/lookupOptionController.js'), calls, options }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('lookup option values persist through the database-backed create/list controller paths', () => {
  const { controller, calls, options } = loadController()
  const created = responseMock()
  controller.createOption({ body: { category: 'equipment_type', value: '  Projector  ' }, user: { id: 8, role: 'Inventory Staff' } }, created)
  assert.equal(created.code, 201)
  assert.equal(created.body.option.value, 'Projector')
  assert.equal(options.length, 1)
  assert.equal(calls[0].values[1], 'Projector')
  assert.equal(calls[0].values[2], 8)
  const listed = responseMock()
  controller.getOptions({ query: { category: 'equipment_type' }, user: { id: 8, role: 'Inventory Staff' } }, listed)
  assert.deepEqual(listed.body.options.map(item => item.value), ['Projector'])
})

test('lookup option controller rejects invalid categories and blank or oversized values before SQL', () => {
  const { controller, calls } = loadController()
  for (const body of [{ category: 'arbitrary_sql', value: 'X' }, { category: 'equipment_type', value: '   ' }, { category: 'equipment_type', value: 'x'.repeat(101) }]) {
    const response = responseMock()
    controller.createOption({ body, user: { id: 1, role: 'MIS' } }, response)
    assert.equal(response.code, 400)
  }
  const listResponse = responseMock()
  controller.getOptions({ query: { category: 'unknown' }, user: { id: 1, role: 'MIS' } }, listResponse)
  assert.equal(listResponse.code, 400)
  assert.equal(calls.length, 0)
})

test('MIS Staff may save computer and equipment options but never the laboratory status list', () => {
  const { controller, calls } = loadController()
  const lab = responseMock()
  controller.createOption({ body: { category: 'laboratory_status', value: 'Under renovation' }, user: { id: 2, role: 'Inventory Staff' } }, lab)
  assert.equal(lab.code, 403)
  assert.equal(calls.length, 0)
  for (const category of ['computer_status', 'equipment_status']) {
    const allowed = responseMock()
    controller.createOption({ body: { category, value: 'NEEDS CALIBRATION' }, user: { id: 2, role: 'Inventory Staff' } }, allowed)
    assert.equal(allowed.code, 201, category)
  }
  const mis = responseMock()
  controller.createOption({ body: { category: 'laboratory_status', value: 'Under renovation' }, user: { id: 1, role: 'MIS' } }, mis)
  assert.equal(mis.code, 201)
  const builtIn = responseMock()
  controller.createOption({ body: { category: 'laboratory_status', value: ' open ' }, user: { id: 1, role: 'MIS' } }, builtIn)
  assert.equal(builtIn.code, 409)
})

test('lookup option controller rejects callers without an allowed role even if invoked directly', () => {
  const { controller, calls } = loadController()
  const create = responseMock()
  controller.createOption({ body: { category: 'equipment_type', value: 'Scanner' }, user: { id: 3, role: 'Teacher' } }, create)
  assert.equal(create.code, 403)
  const list = responseMock()
  controller.getOptions({ query: { category: 'equipment_type' }, user: { id: 3, role: 'Teacher' } }, list)
  assert.equal(list.code, 403)
  assert.equal(calls.length, 0)
})

test('duplicate lookup options return a conflict response', () => {
  const { controller } = loadController({ duplicate: true })
  const response = responseMock()
  controller.createOption({ body: { category: 'equipment_type', value: 'Projector' }, user: { id: 1, role: 'MIS' } }, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /already exists/i)
})


test('lookup option controller rejects built-in values case-insensitively before database writes', () => {
  const { controller, calls, options } = loadController()
  for (const body of [
    { category: 'computer_storage_unit', value: ' gb ' },
    { category: 'computer_status', value: 'active' },
    { category: 'equipment_status', value: 'Working' },
    { category: 'equipment_type', value: 'scanner' }
  ]) {
    const response = responseMock()
    controller.createOption({ body, user: { id: 1, role: 'MIS' } }, response)
    assert.equal(response.code, 409)
    assert.match(response.body.message, /built-in option/i)
  }
  assert.equal(calls.length, 0)
  assert.equal(options.length, 0)
})
