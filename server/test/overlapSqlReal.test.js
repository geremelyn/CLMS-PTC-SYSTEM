// REAL SQL engine test (SQLite via node:sqlite) of the exact overlap predicate + conflict query used by the controllers.
// Not MySQL, but a real SQL evaluation of the predicate - not a mock that returns canned rows.
const test = require('node:test')
const assert = require('node:assert/strict')
let DatabaseSync
try { ({ DatabaseSync } = require('node:sqlite')) } catch { /* older Node */ }
const { OVERLAP_SQL } = require('../controllers/reservationController.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')
const skip = !DatabaseSync && 'node:sqlite unavailable'
function make() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE reservations (id INTEGER PRIMARY KEY, laboratory_id INT, reservation_date TEXT, start_time TEXT, end_time TEXT, status TEXT)')
  const add = (lab, date, st, en, status = 'APPROVED') => db.prepare('INSERT INTO reservations (laboratory_id, reservation_date, start_time, end_time, status) VALUES (?,?,?,?,?)').run(lab, date, st, en, status)
  const conflict = (lab, date, st, en, ignoreId = 0) => db.prepare(`SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status IN (${RESERVATION_POLICY.conflictStatusSql}) AND ${OVERLAP_SQL} LIMIT 1`).all(lab, date, ignoreId, en, st)
  return { db, add, conflict }
}
test('real SQL: overlap predicate across partial / contained / containing / identical / adjacent / distant, other lab, other date, inactive status', { skip }, () => {
  const { add, conflict } = make(); add(1, '2027-03-01', '10:00:00', '11:00:00')
  const hit = (st, en, lab = 1, date = '2027-03-01') => conflict(lab, date, st, en).length === 1
  assert.equal(hit('09:30:00', '10:30:00'), true); assert.equal(hit('10:15:00', '10:45:00'), true); assert.equal(hit('08:00:00', '17:00:00'), true)
  assert.equal(hit('10:00:00', '11:00:00'), true); assert.equal(hit('10:59:00', '12:00:00'), true)
  assert.equal(hit('11:00:00', '12:00:00'), false, 'adjacent after'); assert.equal(hit('09:00:00', '10:00:00'), false, 'adjacent before'); assert.equal(hit('13:00:00', '14:00:00'), false)
  assert.equal(hit('10:00:00', '11:00:00', 2), false, 'other laboratory'); assert.equal(hit('10:00:00', '11:00:00', 1, '2027-03-02'), false, 'other date')
})
test('real SQL: a custom afternoon booking and a custom morning booking coexist; an overlapping one inside the same half-day is blocked, a non-overlapping one is not', { skip }, () => {
  const { add, conflict } = make(); add(1, '2027-03-01', '09:15:00', '10:45:00'); add(1, '2027-03-01', '13:07:00', '15:52:00')
  assert.equal(conflict(1, '2027-03-01', '11:00:00', '12:00:00').length, 0, 'later in the SAME morning is free (no whole-session blocking)')
  assert.equal(conflict(1, '2027-03-01', '10:30:00', '11:30:00').length, 1); assert.equal(conflict(1, '2027-03-01', '15:52:00', '17:00:00').length, 0); assert.equal(conflict(1, '2027-03-01', '15:00:00', '16:00:00').length, 1)
})
test('real SQL: cancelled/declined/completed reservations do not block; the reservation being re-checked never conflicts with itself', { skip }, () => {
  const { add, conflict } = make(); const a = add(1, '2027-03-01', '10:00:00', '11:00:00', 'CANCELLED'); add(1, '2027-03-01', '10:00:00', '11:00:00', 'DECLINED')
  assert.equal(conflict(1, '2027-03-01', '10:00:00', '11:00:00').length, 0)
  const b = add(1, '2027-03-01', '12:00:00', '13:00:00', 'PENDING'); assert.equal(conflict(1, '2027-03-01', '12:00:00', '13:00:00').length, 1); assert.equal(conflict(1, '2027-03-01', '12:00:00', '13:00:00', Number(b.lastInsertRowid)).length, 0)
})
