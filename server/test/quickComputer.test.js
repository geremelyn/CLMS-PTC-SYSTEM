'use strict'
// MOCKED database: verifies validation, duplicate/capacity guards and the insert for createQuickComputer.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function load(rowsInLab, capacity = 5) {
  const calls = []
  const db = { query(sql, values, cb) {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT id, capacity')) return cb(null, capacity == null ? [] : [{ id: 1, capacity }])
    if (sql.startsWith('SELECT id, LOWER')) return cb(null, rowsInLab)
    if (sql.startsWith('INSERT INTO computers')) return cb(null, { insertId: 77 })
    cb(new Error('unexpected ' + sql))
  } }
  db.getConnection = cb => cb(null, { query: db.query, beginTransaction: c => c(), commit: c => c(), rollback: c => c(), release() {} })
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  const cp = path.resolve(__dirname, '../controllers/computerController.js'); delete require.cache[cp]
  return { controller: require(cp), calls }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
test('quick computer: creates a minimal record', async () => {
  const { controller, calls } = load([])
  const r = res(); controller.createQuickComputer({ body: { computer_name: '  PC   07 ', laboratory_id: 1 }, user: { id: 2 } }, r); await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.code, 201); assert.equal(r.body.computer.computer_name, 'PC 07'); assert.equal(calls.at(-1).values[0], 'PC 07')
})
test('quick computer: rejects duplicates (case-insensitive), full labs, missing lab, blank name', async () => {
  let r = res(); load([{ id: 3, lname: 'pc 07' }]).controller.createQuickComputer({ body: { computer_name: 'PC 07', laboratory_id: 1 } }, r); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.code, 409)
  r = res(); load([{ id: 3, lname: 'a' }], 1).controller.createQuickComputer({ body: { computer_name: 'PC 08', laboratory_id: 1 } }, r); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.code, 400)
  r = res(); load([], null).controller.createQuickComputer({ body: { computer_name: 'PC', laboratory_id: 9 } }, r); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.code, 404)
  r = res(); load([]).controller.createQuickComputer({ body: { computer_name: '  ', laboratory_id: 1 } }, r); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.code, 400)
  r = res(); load([]).controller.createQuickComputer({ body: { computer_name: 'PC', laboratory_id: 'x' } }, r); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.code, 400)
})
