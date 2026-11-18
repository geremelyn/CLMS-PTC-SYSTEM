const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
function setupFakeController({ reservation, conflicts = [], holidayRows = [] }) {
  const calls = []
  const connection = {
    beginTransaction(callback) { calls.push('BEGIN'); callback(null) },
    commit(callback) { calls.push('COMMIT'); callback(null) },
    rollback(callback) { calls.push('ROLLBACK'); callback(null) },
    release() { calls.push('RELEASE') },
    query(sql, values, callback) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push(normalized)
      if (normalized.includes('FROM holidays')) return callback(null, holidayRows)
      if (normalized.startsWith('SELECT id, laboratory_id FROM reservations')) return callback(null, [{ id: 10, laboratory_id: 1 }])
      if (normalized.startsWith('SELECT id FROM laboratories')) return callback(null, [{ id: 1 }])
      if (normalized.includes('TIMESTAMPDIFF(SECOND, decided_at')) return callback(null, [reservation])
      if (normalized.startsWith('SELECT id, laboratory_id, reservation_date')) return callback(null, [reservation])
      if (normalized.startsWith('SELECT id, start_time, end_time FROM reservations WHERE laboratory_id')) return callback(null, conflicts)
      if (normalized.startsWith('SELECT id FROM reservations WHERE laboratory_id')) return callback(null, []) // CP105B: no overlapping PENDING requests to cancel
      if (normalized.startsWith('UPDATE reservations SET')) return callback(null, { affectedRows: 1 })
      throw new Error(`Unexpected mock SQL: ${normalized}`)
    }
  }
  const fakeDb = {
    getConnection(callback) { callback(null, connection) },
    query(sql, values, callback) { if (typeof values === 'function') callback = values; if (callback) callback(null, { affectedRows: 1, insertId: 1 }) }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb }
  delete require.cache[auditPath]
  delete require.cache[path.resolve(__dirname, '../controllers/reservationController.js')]
  const controller = require('../controllers/reservationController.js')
  return { controller, calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('approval transaction locks laboratory before reservation and commits after conflict check', async () => {
  const reservation = { id: 10, laboratory_id: 1, reservation_date: '2026-10-28', start_time: '09:00:00', end_time: '10:00:00', status: 'PENDING' }
  const { controller, calls } = setupFakeController({ reservation })
  const response = responseMock()
  await controller.decideReservation({ params: { id: '10' }, body: { decision: 'APPROVED' }, user: { id: 2, role: 'MIS' } }, response)
  assert.equal(response.code, 200)
  assert.ok(calls.indexOf('BEGIN') < calls.findIndex(call => call.startsWith('SELECT id FROM laboratories')))
  assert.ok(calls.findIndex(call => call.startsWith('SELECT id FROM laboratories')) < calls.findIndex(call => call.startsWith('SELECT id, laboratory_id, reservation_date')))
  assert.ok(calls.includes('COMMIT'))
  assert.ok(!calls.includes('ROLLBACK'))
})
test('approval conflict returns 409 and rolls back before any status update', async () => {
  const reservation = { id: 10, laboratory_id: 1, reservation_date: '2026-10-28', start_time: '09:00:00', end_time: '10:00:00', status: 'PENDING' }
  const { controller, calls } = setupFakeController({ reservation, conflicts: [{ id: 11 }] })
  const response = responseMock()
  await controller.decideReservation({ params: { id: '10' }, body: { decision: 'APPROVED' }, user: { id: 2, role: 'MIS' } }, response)
  assert.equal(response.code, 409)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(call => call.startsWith('UPDATE reservations SET')))
})
test('decision undo re-locks the lab and commits a conditional return to pending', async () => {
  const reservation = { id: 10, laboratory_id: 1, reservation_date: '2026-10-28', start_time: '13:00:00', end_time: '14:00:00', status: 'DECLINED', decided_at: '2026-10-27 10:00:00', decided_by: 2, seconds_since_decision: 120 }
  const { controller, calls } = setupFakeController({ reservation })
  const response = responseMock()
  await controller.undoDecisionReservation({ params: { id: '10' }, user: { id: 2, role: 'MIS' } }, response)
  assert.equal(response.code, 200)
  assert.ok(calls.includes('COMMIT'))
  assert.ok(calls.some(call => call.includes("SET status = 'PENDING'")))
  assert.ok(!calls.includes('ROLLBACK'))
})

test('undoing a DECLINE is refused when the date is now a holiday; undoing an APPROVAL is still allowed (it only reduces access)', async () => {
  const base = { id: 10, laboratory_id: 1, reservation_date: '2026-12-25', start_time: '13:00:00', end_time: '14:00:00', decided_at: '2026-10-27 10:00:00', decided_by: 2, seconds_since_decision: 120 }
  const declined = setupFakeController({ reservation: { ...base, status: 'DECLINED' } }); const r1 = responseMock()
  await declined.controller.undoDecisionReservation({ params: { id: '10' }, user: { id: 2, role: 'MIS' } }, r1)
  assert.equal(r1.code, 409); assert.match(r1.body.message, /Christmas Day/); assert.ok(declined.calls.includes('ROLLBACK')); assert.ok(!declined.calls.some(c => c.includes("SET status = 'PENDING'")))
  const approved = setupFakeController({ reservation: { ...base, status: 'APPROVED' } }); const r2 = responseMock()
  await approved.controller.undoDecisionReservation({ params: { id: '10' }, user: { id: 2, role: 'MIS' } }, r2)
  assert.equal(r2.code, 200)
})
test('CP08: approving is refused (409, rolled back, no UPDATE) when the date is now a holiday; a normal date with a custom time is approved', async () => {
  const base = { id: 10, laboratory_id: 1, start_time: '13:07:00', end_time: '15:52:00', status: 'PENDING' }
  const holiday = setupFakeController({ reservation: { ...base, reservation_date: '2026-12-25' } }); const r1 = responseMock()
  await holiday.controller.decideReservation({ params: { id: '10' }, body: { decision: 'APPROVED' }, user: { id: 2, role: 'MIS' } }, r1)
  assert.equal(r1.code, 409); assert.match(r1.body.message, /Christmas Day/); assert.ok(holiday.calls.includes('ROLLBACK')); assert.ok(!holiday.calls.some(c => c.startsWith('UPDATE reservations SET')))
  const declinedOnHoliday = setupFakeController({ reservation: { ...base, reservation_date: '2026-12-25' } }); const r2 = responseMock()
  await declinedOnHoliday.controller.decideReservation({ params: { id: '10' }, body: { decision: 'DECLINED', decision_note: 'Holiday' }, user: { id: 2, role: 'MIS' } }, r2)
  assert.equal(r2.code, 200) // declining a flagged reservation is still allowed
  const normal = setupFakeController({ reservation: { ...base, reservation_date: '2026-12-23' } }); const r3 = responseMock()
  await normal.controller.decideReservation({ params: { id: '10' }, body: { decision: 'APPROVED' }, user: { id: 2, role: 'MIS' } }, r3)
  assert.equal(r3.code, 200); assert.ok(normal.calls.includes('COMMIT'))
})
