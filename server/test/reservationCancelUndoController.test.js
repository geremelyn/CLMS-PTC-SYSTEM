const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

function setup({ conflicts = [], reservation = {}, updateAffectedRows = 1, failUpdate = false, holidayRows = [] } = {}) {
  const calls = []
  const row = {
    id: 22, laboratory_id: 3, reserved_by: 7,
    reservation_date: '2026-10-29', start_time: '09:00:00', end_time: '10:00:00',
    status: 'CANCELLED', cancelled_at: '2026-10-27 10:00:00', seconds_since_cancel: 90,
    ...reservation
  }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) },
    commit(cb) { calls.push('COMMIT'); cb(null) },
    rollback(cb) { calls.push('ROLLBACK'); cb(null) },
    release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push(normalized)
      if (normalized.startsWith('SELECT id, laboratory_id FROM reservations')) return cb(null, [{ id: 22, laboratory_id: 3 }])
      if (normalized.includes('FROM holidays')) return cb(null, holidayRows)
      if (normalized.startsWith('SELECT id FROM laboratories')) return cb(null, [{ id: 3 }])
      if (normalized.includes('TIMESTAMPDIFF(SECOND, cancelled_at')) return cb(null, [row])
      if (normalized.startsWith('SELECT id, start_time, end_time FROM reservations WHERE laboratory_id')) return cb(null, conflicts)
      if (normalized.startsWith('UPDATE reservations SET status = \'APPROVED\'')) {
        if (failUpdate) return cb(Object.assign(new Error('simulated SQL failure'), { code: 'ER_BAD_FIELD_ERROR' }))
        return cb(null, { affectedRows: updateAffectedRows })
      }
      throw new Error(`Unexpected mock SQL: ${normalized}`)
    }
  }
  const fakeDb = { getConnection(cb) { cb(null, connection) } }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/reservationController.js')
  const dbModule = new Module(dbPath); dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakeDb; require.cache[dbPath] = dbModule
  const auditModule = new Module(auditPath); auditModule.filename = auditPath; auditModule.loaded = true; auditModule.exports = { logAudit() {} }; require.cache[auditPath] = auditModule
  delete require.cache[controllerPath]
  return { controller: require(controllerPath), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }
const request = { params: { id: '22' }, user: { id: 7, role: 'Teacher' } }

test('cancellation undo locks lab and reservation, checks conflicts, and commits atomically', async () => {
  const { controller, calls } = setup()
  const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 200)
  assert.ok(calls.indexOf('BEGIN') < calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')))
  assert.ok(calls.findIndex(sql => sql.startsWith('SELECT id FROM laboratories')) < calls.findIndex(sql => sql.includes('TIMESTAMPDIFF(SECOND, cancelled_at')))
  assert.ok(calls.some(sql => sql.startsWith('SELECT id, start_time, end_time FROM reservations WHERE laboratory_id')))
  assert.ok(calls.includes('COMMIT'))
  assert.ok(!calls.includes('ROLLBACK'))
})

test('cancellation undo refuses a conflicting reservation and rolls back', async () => {
  const { controller, calls } = setup({ conflicts: [{ id: 23 }] })
  const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /overlaps/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(sql => sql.startsWith('UPDATE reservations SET status = \'APPROVED\'')))
})

test('cancellation undo refuses stale updates and rolls back', async () => {
  const { controller, calls } = setup({ updateAffectedRows: 0 })
  const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /changed before/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.includes('COMMIT'))
})

test('cancellation undo rolls back on a database update failure', async () => {
  const { controller, calls } = setup({ failUpdate: true })
  const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 500)
  assert.match(response.body.message, /no changes were saved/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.includes('COMMIT'))
})

test('cancellation undo enforces ownership for Dean and Teacher roles', async () => {
  const { controller, calls } = setup({ reservation: { reserved_by: 999 } })
  const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 403)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(sql => sql.startsWith('UPDATE reservations SET status = \'APPROVED\'')))
})

test('MIS cannot undo a cancellation made by the Teacher (no "Undo cancellation" for someone else\'s cancel)', async () => {
  const { controller, calls } = setup({ reservation: { cancelled_by: 7 } }); const response = responseMock()
  await controller.undoCancelReservation({ params: { id: '22' }, user: { id: 1, role: 'MIS' } }, response)
  assert.equal(response.code, 403); assert.match(response.body.message, /person who cancelled/)
  assert.ok(calls.includes('ROLLBACK') && !calls.some(c => c.startsWith("UPDATE reservations SET status = 'APPROVED'")))
})
test('the Teacher who cancelled can undo; MIS can undo only its own cancellation', async () => {
  for (const [user, cancelled_by, code] of [[{ id: 7, role: 'Teacher' }, 7, 200], [{ id: 1, role: 'MIS' }, 1, 200], [{ id: 1, role: 'MIS' }, 2, 403], [{ id: 1, role: 'MIS' }, null, 403]]) {
    const { controller } = setup({ reservation: { cancelled_by } }); const response = responseMock()
    await controller.undoCancelReservation({ params: { id: '22' }, user }, response)
    assert.equal(response.code, code, `${user.role} cancelled_by=${cancelled_by}: ${JSON.stringify(response.body)}`)
  }
})
test('a Teacher cannot undo a cancellation that MIS performed on their reservation', async () => {
  const { controller } = setup({ reservation: { cancelled_by: 1 } }); const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 403)
})

test('cancellation undo is refused (409, rolled back, nothing updated) when the date has since become a holiday', async () => {
  const hol = { id: 1, holiday_date: '2026-10-29', name: 'Typhoon Closure', holiday_type: 'SPECIAL_NON_WORKING', is_active: 1 }
  const { controller, calls } = setup({ holidayRows: [hol] }); const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 409); assert.match(response.body.message, /Typhoon Closure/); assert.match(response.body.message, /Cannot undo this cancellation/)
  assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(sql => sql.startsWith("UPDATE reservations SET status = 'APPROVED'")))
})
test('cancellation undo is refused on a built-in holiday even when the holidays table has no row (fail-safe baseline)', async () => {
  const { controller, calls } = setup({ reservation: { reservation_date: '2026-12-25' }, holidayRows: [] }); const response = responseMock()
  await controller.undoCancelReservation(request, response)
  assert.equal(response.code, 409); assert.match(response.body.message, /Christmas Day/); assert.ok(!calls.some(sql => sql.startsWith("UPDATE reservations SET status = 'APPROVED'")))
})
test('cancellation undo is allowed on a special WORKING day and when MIS removed (deactivated) the holiday', async () => {
  for (const [date, rows] of [['2026-02-25', []], ['2026-12-25', [{ id: 9, holiday_date: '2026-12-25', name: 'Christmas Day', holiday_type: 'REGULAR', is_active: 0 }]]]) {
    const { controller, calls } = setup({ reservation: { reservation_date: date }, holidayRows: rows }); const response = responseMock()
    await controller.undoCancelReservation(request, response)
    assert.equal(response.code, 200, date); assert.ok(calls.includes('COMMIT'))
  }
})
