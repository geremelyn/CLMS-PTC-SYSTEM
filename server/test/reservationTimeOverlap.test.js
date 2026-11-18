// CP23 - reservation time validation + overlap prevention.
// MOCKED database: an in-memory table evaluates the SAME predicate/params the controller sends (lab, date, status IN (...),
// start_time < ? AND end_time > ?). This is NOT a real MySQL/MariaDB test.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const T = require('../config/reservationTime.js')
const PH = require('../utils/philippineHolidays.js')
function futureDate(days) { let d = new Date(Date.now() + days * 86400000); for (let i = 0; i < 30; i++) { const s = d.toISOString().slice(0, 10); if (d.getUTCDay() !== 0 && PH.evaluateReservableDate(s, PH.baselineForDate(s)).ok) return s; d = new Date(d.getTime() + 86400000) } }
const D1 = futureDate(10); let D2 = futureDate(12); for (let k = 13; D2 === D1; k++) D2 = futureDate(k)
function makeEnv(rows) {
  let nextId = 100
  const connection = {
    beginTransaction(cb) { cb(null) }, commit(cb) { cb(null) }, rollback(cb) { cb(null) }, release() {},
    query(sql, v, cb) {
      const n = sql.replace(/\s+/g, ' ').trim()
      if (n.startsWith('SELECT id, status, available_from')) return cb(null, [{ id: v[0], status: 'OPEN', available_from: '08:00:00', available_until: '17:00:00' }])
      if (n.startsWith('SELECT id, start_time, end_time FROM reservations')) {
        const statuses = [...n.match(/status IN \(([^)]*)\)/)[1].matchAll(/'(\w+)'/g)].map(m => m[1]); const [lab, date, endParam, startParam] = v
        return cb(null, rows.filter(r => r.laboratory_id === lab && r.reservation_date === date && statuses.includes(r.status) && r.start_time < endParam && r.end_time > startParam))
      }
      if (n.startsWith('INSERT INTO reservations')) { const id = nextId++; rows.push({ id, laboratory_id: v[0], reservation_date: v[2], start_time: v[3], end_time: v[4], status: v[8] }); return cb(null, { insertId: id }) }
      throw new Error('Unexpected SQL ' + n)
    } }
  const pool = { query(sql, v, cb) { if (/FROM users/.test(sql)) return cb(null, [{ id: 7, full_name: 'T', role: 'Teacher', status: 'ACTIVE' }]); if (/FROM holidays/.test(sql)) return cb(null, []); if (/FROM laboratories/.test(sql)) return cb(null, [{ id: 1, laboratory_name: 'L', status: 'OPEN', available_from: '08:00:00', available_until: '17:00:00' }]); throw new Error('pool ' + sql) }, getConnection(cb) { cb(null, connection) } }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), cp = path.resolve(__dirname, '../controllers/reservationController.js')
  for (const [p, exp] of [[dbPath, pool], [auditPath, { logAudit() {} }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[cp]; return require(cp)
}
const res = () => ({ code: 200, body: null, headersSent: false, status(c) { this.code = c; return this }, json(b) { this.body = b; this.headersSent = true; return this } })
function book(ctl, start, end, { date = D1, lab = 1 } = {}) { const r = res(); ctl.createReservation({ user: { id: 7, role: 'Teacher' }, body: { laboratory_id: lab, reservation_date: date, start_time: start, end_time: end, purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Prof' } }, r); return r }

test('validateTimeRange: config defaults 07:00-21:00 with 30-minute steps (single source)', () => {
  assert.equal(T.OPEN, '07:00'); assert.equal(T.CLOSE, '21:00'); assert.equal(T.STEP_MINUTES, 30)
  const o = T.timeOptions(); assert.equal(o[0], '07:00'); assert.equal(o.at(-1), '21:00'); assert.equal(o.length, 29); assert.ok(o.includes('16:30'))
})
test('operating hours boundaries: 07:00 start and 21:00 end allowed; 06:30 / 21:30 / 06:30-21:30 rejected', () => {
  assert.equal(T.validateTimeRange('07:00', '07:30').ok, true); assert.equal(T.validateTimeRange('20:30', '21:00').ok, true); assert.equal(T.validateTimeRange('07:00', '21:00').ok, true)
  for (const [a, b] of [['06:30', '07:30'], ['20:30', '21:30'], ['06:30', '21:30'], ['00:00', '01:00'], ['22:00', '23:00']]) assert.equal(T.validateTimeRange(a, b).ok, false, a + '-' + b)
})
test('30-minute increments enforced; HH:MM:SS with :00 accepted, other seconds rejected; end must be after start', () => {
  assert.equal(T.validateTimeRange('09:15', '10:00').ok, false); assert.equal(T.validateTimeRange('09:00', '10:10').ok, false); assert.equal(T.validateTimeRange('09:00:00', '10:30:00').ok, true)
  assert.equal(T.validateTimeRange('09:00:30', '10:00:00').ok, false); assert.equal(T.validateTimeRange('10:00', '10:00').ok, false); assert.equal(T.validateTimeRange('11:00', '10:00').ok, false)
})
test('flexible durations: 30 minutes up to the whole operating day (multi-hour allowed)', () => {
  for (const [a, b] of [['09:00', '09:30'], ['09:00', '12:00'], ['13:00', '16:30'], ['07:00', '21:00']]) assert.equal(T.validateTimeRange(a, b).ok, true, a + '-' + b)
})
test('examples: 7-9 allowed; 8-10 same lab/date blocked once 7-9 is APPROVED; 9-12 allowed after a 9:00 end; 1:00-4:30 PM allowed', () => {
  const rows = [], ctl = makeEnv(rows)
  assert.equal(book(ctl, '07:00', '09:00').code, 201); rows.forEach(r => { r.status = 'APPROVED' }) // CP105A: only APPROVED blocks
  const blocked = book(ctl, '08:00', '10:00'); assert.equal(blocked.code, 409); assert.equal(blocked.body.code, 'SLOT_TAKEN'); assert.equal(rows.length, 1)
  assert.equal(book(ctl, '09:00', '12:00').code, 201)
  assert.equal(book(ctl, '13:00', '16:30').code, 201); assert.equal(rows.length, 3)
})
test('overlap shapes on the same lab/date: partial-start, partial-end, contained, containing, identical all blocked; back-to-back allowed', () => {
  const rows = [], ctl = makeEnv(rows); assert.equal(book(ctl, '10:00', '12:00').code, 201); rows.forEach(r => { r.status = 'APPROVED' }) // CP105A
  for (const [a, b] of [['09:00', '10:30'], ['11:30', '13:00'], ['10:30', '11:30'], ['09:00', '13:00'], ['10:00', '12:00']]) assert.equal(book(ctl, a, b).code, 409, a + '-' + b)
  assert.equal(book(ctl, '08:00', '10:00').code, 201); assert.equal(book(ctl, '12:00', '14:00').code, 201)
})
test('different dates and different laboratories never conflict', () => {
  const rows = [], ctl = makeEnv(rows); assert.equal(book(ctl, '08:00', '10:00').code, 201)
  assert.equal(book(ctl, '08:00', '10:00', { date: D2 }).code, 201); assert.equal(book(ctl, '08:00', '10:00', { lab: 2 }).code, 201)
})
test('statuses: APPROVED occupies the slot; PENDING (CP105A), DECLINED and CANCELLED do not', () => {
  for (const [status, expected] of [['PENDING', 201], ['APPROVED', 409], ['DECLINED', 201], ['CANCELLED', 201]]) {
    const rows = [{ id: 1, laboratory_id: 1, reservation_date: D1, start_time: '09:00:00', end_time: '11:00:00', status }]
    assert.equal(book(makeEnv(rows), '10:00', '12:00').code, expected, status)
  }
})
test('API rejects invalid times before touching the database (backend validation, not frontend only)', () => {
  const rows = [], ctl = makeEnv(rows)
  for (const [a, b] of [['06:00', '08:00'], ['20:00', '22:00'], ['09:10', '10:00'], ['10:00', '09:00'], ['abc', '10:00'], [undefined, '10:00']]) { const r = book(ctl, a, b); assert.equal(r.code, 400, String(a) + '-' + b); assert.ok(r.body.message) }
  assert.equal(rows.length, 0)
})
