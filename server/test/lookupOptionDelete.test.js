'use strict'
// MOCKED tests: a fake db object is injected. They prove controller logic only, not real MySQL behaviour.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function load({ options = [], liveCount = 0, recycledCount = 0 } = {}) {
  const calls = []
  const fakeDb = {
    query(sql, values, callback) {
      const text = sql.replace(/\s+/g, ' ').trim()
      calls.push({ sql: text, values })
      if (text.startsWith('SELECT id, category, value FROM lookup_options WHERE id')) return callback(null, options.filter(o => o.id === values[0]))
      if (text.includes('FROM recycle_bin')) return callback(null, [{ total: recycledCount }])
      if (text.startsWith('SELECT COUNT(*) AS total FROM `')) return callback(null, [{ total: liveCount }])
      if (text.startsWith('DELETE FROM lookup_options')) {
        const index = options.findIndex(o => o.id === values[0])
        if (index < 0) return callback(null, { affectedRows: 0 })
        options.splice(index, 1)
        return callback(null, { affectedRows: 1 })
      }
      callback(new Error('Unexpected SQL: ' + text))
    }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/lookupOptionController.js')
  const audit = []
  for (const [file, exports] of [[dbPath, fakeDb], [auditPath, { logAudit: (...args) => audit.push(args) }]]) {
    const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m
  }
  delete require.cache[controllerPath]
  return { controller: require(controllerPath), calls, options, audit }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const asMis = { id: 1, role: 'MIS' }

test('unused custom option is deleted and audited', async () => {
  const { controller, options, audit } = load({ options: [{ id: 5, category: 'equipment_type', value: 'Projector' }] })
  const r = res(); await controller.deleteOption({ params: { id: '5' }, user: asMis }, r)
  assert.equal(r.code, 200); assert.equal(options.length, 0); assert.equal(audit.length, 1)
})

test('equipment option still used by records can be deleted; records are untouched (plain text)', async () => {
  const { controller, options, calls } = load({ options: [{ id: 5, category: 'equipment_type', value: 'Projector' }], liveCount: 3 })
  const r = res(); await controller.deleteOption({ params: { id: '5' }, user: asMis }, r)
  assert.equal(r.code, 200); assert.equal(options.length, 0)
  assert.ok(!calls.some(c => c.sql.includes('FROM `equipment`') || c.sql.includes('UPDATE')))
})

test('laboratory custom status still used by a laboratory can be deleted; laboratories untouched', async () => {
  const { controller, options, calls } = load({ options: [{ id: 6, category: 'laboratory_status', value: 'Renovation' }], liveCount: 2 })
  const r = res(); await controller.deleteOption({ params: { id: '6' }, user: asMis }, r)
  assert.equal(r.code, 200); assert.equal(options.length, 0)
  assert.ok(!calls.some(c => c.sql.includes('laboratories') || c.sql.includes('UPDATE')))
})

test('computer option still used by Recycle Bin snapshot can be deleted; history is plain text and untouched', async () => {
  const { controller, options } = load({ options: [{ id: 7, category: 'computer_condition', value: 'Obsolete' }], recycledCount: 1 })
  const r = res(); await controller.deleteOption({ params: { id: '7' }, user: asMis }, r)
  assert.equal(r.code, 200); assert.equal(options.length, 0)
})

test('usage query targets the right table/column per category', async () => {
  const { controller, calls } = load({ options: [{ id: 2, category: 'laboratory_status', value: 'Renovation' }] })
  await controller.deleteOption({ params: { id: '2' }, user: asMis }, res())
  assert.ok(!calls.some(c => c.sql.includes('FROM `laboratories`')))
  const second = load({ options: [{ id: 3, category: 'computer_status', value: 'Spare' }] })
  await second.controller.deleteOption({ params: { id: '3' }, user: asMis }, res())
  assert.ok(!second.calls.some(c => c.sql.includes('FROM `computers`')))
})

test('MIS Staff cannot delete laboratory status options; unknown id is 404; bad id is 400', async () => {
  const { controller, options } = load({ options: [{ id: 2, category: 'laboratory_status', value: 'Renovation' }] })
  let r = res(); await controller.deleteOption({ params: { id: '2' }, user: { id: 9, role: 'Inventory Staff' } }, r)
  assert.equal(r.code, 403); assert.equal(options.length, 1)
  r = res(); await controller.deleteOption({ params: { id: '99' }, user: asMis }, r); assert.equal(r.code, 404)
  r = res(); await controller.deleteOption({ params: { id: 'abc' }, user: asMis }, r); assert.equal(r.code, 400)
})

test('a built-in value can never be deleted even if a stray row exists', async () => {
  const { controller, options } = load({ options: [{ id: 4, category: 'computer_storage_unit', value: 'gb' }] })
  const r = res(); await controller.deleteOption({ params: { id: '4' }, user: asMis }, r)
  assert.equal(r.code, 400); assert.equal(options.length, 1)
})

test('database failure reports an error and changes nothing', async () => {
  const { controller } = load({ options: [{ id: 5, category: 'equipment_type', value: 'X' }] })
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const original = require.cache[dbPath].exports.query
  require.cache[dbPath].exports.query = (sql, values, cb) => cb(Object.assign(new Error('boom'), { code: 'ER_X' }))
  const r = res(); await controller.deleteOption({ params: { id: '5' }, user: asMis }, r)
  require.cache[dbPath].exports.query = original
  assert.equal(r.code, 500); assert.match(r.body.message, /Nothing was changed/)
})
