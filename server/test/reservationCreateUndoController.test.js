const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function setup({ reservation = {}, deleteAffectedRows = 1, failDelete = false } = {}) {
  const calls = []
  const row = { id: 31, reserved_by: 7, status: 'PENDING', created_at: '2026-10-27 10:00:00', decided_by: null, decided_at: null, cancelled_at: null, seconds_since_create: 60, ...reservation }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const normalized = sql.replace(/\s+/g, ' ').trim(); calls.push(normalized)
      if (normalized.startsWith('SELECT id, laboratory_id FROM reservations')) return cb(null, [{ id: 31, laboratory_id: 4 }])
      if (normalized.startsWith('SELECT id FROM laboratories')) return cb(null, [{ id: 4 }])
      if (normalized.includes('TIMESTAMPDIFF(SECOND, created_at')) return cb(null, [row])
      if (normalized.startsWith('DELETE FROM reservations')) {
        if (failDelete) return cb(Object.assign(new Error('simulated delete failure'), { code: 'ER_BAD_FIELD_ERROR' }))
        return cb(null, { affectedRows: deleteAffectedRows })
      }
      throw new Error(`Unexpected mock SQL: ${normalized}`)
    }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), controllerPath = path.resolve(__dirname, '../controllers/reservationController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = { getConnection(cb) { cb(null, connection) } }; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  return { controller: require(controllerPath), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }
const request = { params: { id: '31' }, user: { id: 7, role: 'Teacher' } }
test('creation undo deletes only a recent unprocessed reservation inside a transaction', async () => {
  const { controller, calls } = setup(), response = responseMock()
  await controller.undoCreateReservation(request, response)
  assert.equal(response.code, 200)
  assert.ok(calls.includes('BEGIN') && calls.includes('COMMIT') && !calls.includes('ROLLBACK'))
  assert.ok(calls.indexOf('BEGIN') < calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')))
  assert.ok(calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')) < calls.findIndex(sql => sql.includes('TIMESTAMPDIFF(SECOND, created_at')))
  assert.ok(calls.some(sql => sql.startsWith('DELETE FROM reservations')))
})
test('creation undo rejects another users reservation', async () => {
  const { controller, calls } = setup({ reservation: { reserved_by: 999 } }), response = responseMock()
  await controller.undoCreateReservation(request, response)
  assert.equal(response.code, 403); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(sql => sql.startsWith('DELETE FROM reservations')))
})
test('creation undo rejects processed reservations (no 10-minute limit)', async t => {
  for (const reservation of [{ status: 'APPROVED', decided_by: 2, decided_at: '2026-10-27 10:01:00' }, { status: 'CANCELLED', cancelled_at: '2026-10-27 10:01:00' }]) {
    const { controller, calls } = setup({ reservation }), response = responseMock()
    await controller.undoCreateReservation(request, response)
    assert.equal(response.code, 409)
    assert.ok(calls.includes('ROLLBACK'))
    assert.ok(!calls.some(sql => sql.startsWith('DELETE FROM reservations')))
  }
})
test('creation undo rolls back when the conditional delete detects a stale row', async () => {
  const { controller, calls } = setup({ deleteAffectedRows: 0 }), response = responseMock()
  await controller.undoCreateReservation(request, response)
  assert.equal(response.code, 409); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})
test('creation undo rolls back when the database delete fails', async () => {
  const { controller, calls } = setup({ failDelete: true }), response = responseMock()
  await controller.undoCreateReservation(request, response)
  assert.equal(response.code, 500); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})
