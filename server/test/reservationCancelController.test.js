const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function setup({ user = {}, reservation = {}, updateAffectedRows = 1, failUpdate = false } = {}) {
  const calls = []
  const userRow = { id: 7, full_name: 'Teacher A', role: 'Teacher', status: 'ACTIVE', ...user }
  const reservationRow = { id: 41, laboratory_id: 5, reserved_by: 7, status: 'APPROVED', ...reservation }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const normalized = sql.replace(/\s+/g, ' ').trim(); calls.push(normalized)
      if (normalized.startsWith('SELECT id, full_name, role, status FROM users')) return cb(null, [userRow])
      if (normalized.startsWith('SELECT id, laboratory_id FROM reservations')) return cb(null, [{ id: 41, laboratory_id: 5 }])
      if (normalized.startsWith('SELECT id FROM laboratories')) return cb(null, [{ id: 5 }])
      if (normalized.startsWith('SELECT id, laboratory_id, reserved_by, status FROM reservations')) return cb(null, [reservationRow])
      if (normalized.startsWith("UPDATE reservations SET status = 'CANCELLED'")) {
        if (failUpdate) return cb(Object.assign(new Error('simulated update failure'), { code: 'ER_BAD_FIELD_ERROR' }))
        return cb(null, { affectedRows: updateAffectedRows })
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
const request = { params: { id: '41' }, body: { cancellation_note: 'Class schedule changed' }, user: { id: 7, role: 'Teacher' } }
test('cancellation locks laboratory then reservation and commits the conditional update', async () => {
  const { controller, calls } = setup(), response = responseMock()
  await controller.cancelReservation(request, response)
  assert.equal(response.code, 200)
  assert.ok(calls.indexOf('BEGIN') < calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')))
  assert.ok(calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')) < calls.findIndex(sql => sql.startsWith('SELECT id, laboratory_id, reserved_by, status FROM reservations')))
  assert.ok(calls.includes('COMMIT') && !calls.includes('ROLLBACK'))
})
test('cancellation refuses a reservation not owned by Dean or Teacher', async () => {
  const { controller, calls } = setup({ reservation: { reserved_by: 99 } }), response = responseMock()
  await controller.cancelReservation(request, response)
  assert.equal(response.code, 403); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(sql => sql.startsWith("UPDATE reservations SET status = 'CANCELLED'")))
})
test('cancellation refuses a reservation already processed', async () => {
  const { controller, calls } = setup({ reservation: { status: 'CANCELLED' } }), response = responseMock()
  await controller.cancelReservation(request, response)
  assert.equal(response.code, 409); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(sql => sql.startsWith("UPDATE reservations SET status = 'CANCELLED'")))
})
test('cancellation rolls back if a conditional update detects a stale row', async () => {
  const { controller, calls } = setup({ updateAffectedRows: 0 }), response = responseMock()
  await controller.cancelReservation(request, response)
  assert.equal(response.code, 409); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})
test('cancellation rolls back on database failure', async () => {
  const { controller, calls } = setup({ failUpdate: true }), response = responseMock()
  await controller.cancelReservation(request, response)
  assert.equal(response.code, 500); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})
test('cancellation refuses inactive users and missing notes before updating', async () => {
  const inactive = setup({ user: { status: 'INACTIVE' } }), response1 = responseMock()
  await inactive.controller.cancelReservation(request, response1)
  assert.equal(response1.code, 403); assert.ok(!inactive.calls.some(sql => sql.startsWith("UPDATE reservations SET status = 'CANCELLED'")))
  const { controller } = setup(), response2 = responseMock()
  await controller.cancelReservation({ ...request, body: { cancellation_note: ' ' } }, response2)
  assert.equal(response2.code, 400)
})
