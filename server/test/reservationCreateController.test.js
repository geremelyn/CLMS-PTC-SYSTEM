const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PH = require('../utils/philippineHolidays.js')
// Next bookable date at least `days` ahead: skips Sundays and closed (regular / special non-working) holidays.
function futureDate(days) { const d = new Date(Date.now() + days * 86400000); const closed = () => d.getUTCDay() === 0 || PH.evaluateReservableDate(d.toISOString().slice(0, 10), PH.baselineForDate(d.toISOString().slice(0, 10))).ok === false; while (closed()) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
function setup({ role = 'Teacher', conflicts = [], labStatus = 'OPEN', throwOnInsert = false, userStatus = 'ACTIVE', holidayRows = [], labFrom = '08:00:00', labUntil = '17:00:00' } = {}) {
  const calls = []
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push(n)
      if (n.startsWith('SELECT id, status, available_from')) return cb(null, [{ id: 1, status: labStatus, available_from: labFrom, available_until: labUntil, booking_interval: 60 }])
      if (n.startsWith('SELECT id, start_time, end_time FROM reservations')) return cb(null, conflicts)
      if (n.startsWith('INSERT INTO reservations')) { if (throwOnInsert) throw new Error('simulated driver failure'); calls.push({ insert: values }); return cb(null, { insertId: 55 }) }
      throw new Error(`Unexpected SQL: ${n}`)
    }
  }
  const pool = {
    query(sql, values, cb) {
      if (/FROM users/.test(sql)) return cb(null, [{ id: 7, full_name: 'Test User', role, status: userStatus }])
      if (/FROM holidays/.test(sql)) return cb(null, holidayRows)
      if (/FROM laboratories/.test(sql)) return cb(null, [{ id: 1, laboratory_name: 'Laboratory 1', status: labStatus, available_from: labFrom, available_until: labUntil }])
      throw new Error(`Unexpected pool SQL: ${sql}`)
    },
    getConnection(cb) { cb(null, connection) }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), controllerPath = path.resolve(__dirname, '../controllers/reservationController.js')
  for (const [p, exp] of [[dbPath, pool], [auditPath, { logAudit() {} }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[controllerPath]
  return { controller: require(controllerPath), calls }
}
function responseMock() { return { code: 200, body: null, headersSent: false, status(c) { this.code = c; return this }, json(b) { this.body = b; this.headersSent = true; return this } } }
function req(role, body = {}) {
  return { user: { id: 7, role }, body: { laboratory_id: 1, reservation_date: futureDate(10), period: 'MORNING', purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Prof. Cruz', ...body } }
}

for (const role of ['Teacher', 'Dean', 'MIS']) {
  test(`${role} can submit a reservation (regression: db was undefined and crashed the server)`, () => {
    const { controller, calls } = setup({ role }), response = responseMock()
    controller.createReservation(req(role), response)
    assert.equal(response.code, 201, JSON.stringify(response.body))
    assert.equal(response.body.reservation.status, 'PENDING')
    assert.notEqual(response.body.auto_declined, true)
    assert.ok(calls.includes('COMMIT') && calls.includes('RELEASE') && !calls.includes('ROLLBACK'))
  })
}
test('Morning and Afternoon are stored with the confirmed times', () => {
  const { controller } = setup(), a = responseMock(), b = responseMock()
  controller.createReservation(req('Teacher', { period: 'MORNING' }), a)
  controller.createReservation(req('Teacher', { period: 'afternoon' }), b)
  assert.equal(a.code, 201); assert.equal(b.code, 201)
  assert.equal(a.body.reservation.start_time, '08:00:00'); assert.equal(a.body.reservation.end_time, '12:00:00'); assert.equal(a.body.period, 'MORNING')
  assert.equal(b.body.reservation.start_time, '12:00:00'); assert.equal(b.body.reservation.end_time, '17:00:00'); assert.equal(b.body.period, 'AFTERNOON')
})
test('an occupied slot is rejected with 409 SLOT_TAKEN, rolls back and inserts nothing', () => {
  const { controller, calls } = setup({ conflicts: [{ id: 3 }] }), response = responseMock()
  controller.createReservation(req('Dean'), response)
  assert.equal(response.code, 409); assert.equal(response.body.code, 'SLOT_TAKEN'); assert.match(response.body.message, /overlaps an existing reservation/)
  assert.ok(calls.includes('ROLLBACK') && calls.includes('RELEASE') && !calls.includes('COMMIT'))
  assert.ok(!calls.some(c => typeof c === 'object' && c.insert))
})
test('CP81: a request for tomorrow is ACCEPTED as PENDING (no "submit more than 3 days ahead" rejection)', () => {
  const { controller } = setup(), response = responseMock()
  controller.createReservation(req('Teacher', { reservation_date: futureDate(1) }), response)
  assert.equal(response.code, 201); assert.equal(response.body.auto_declined, false); assert.equal(response.body.reservation.status, 'PENDING'); assert.equal(response.body.reservation.decision_note, null)
  assert.doesNotMatch(JSON.stringify(response.body), /NOT SUBMITTED|submitted more than/i); assert.match(response.body.message, /pending approval/i)
})
test('validation is intact: period required, Sunday, missing teacher fields, unauthorized role', () => {
  const run = (role, body) => { const { controller } = setup({ role }), r = responseMock(); controller.createReservation(req(role, body), r); return r }
  assert.equal(run('Teacher', { period: undefined }).code, 400)
  assert.equal(run('Teacher', { period: 'EVENING' }).code, 400)
  assert.equal(run('Teacher', { subject_name: '' }).code, 400)
  assert.equal(run('Inventory Staff', {}).code, 403)
  let sunday = new Date(Date.now() + 14 * 86400000); while (sunday.getUTCDay() !== 0) sunday = new Date(sunday.getTime() + 86400000)
  assert.equal(run('Teacher', { reservation_date: sunday.toISOString().slice(0, 10) }).code, 400)
})
test('a thrown driver error inside a DB callback returns HTTP 500, rolls back, releases the connection and does not crash', () => {
  const { controller, calls } = setup({ throwOnInsert: true }), response = responseMock()
  assert.doesNotThrow(() => controller.createReservation(req('Teacher'), response))
  assert.equal(response.code, 500)
  assert.ok(calls.includes('ROLLBACK') && calls.includes('RELEASE'))
})

// ---- Checkpoint 4: Philippine holidays (Asia/Manila) -------------------------------------------------------
function run(body, opts = {}) { const { controller } = setup(opts); const r = responseMock(); controller.createReservation(req('Teacher', body), r); return r }
test('HOLIDAY: regular holiday blocks booking with the holiday name (baseline fallback when the table has no row)', () => {
  const r = run({ reservation_date: '2026-12-25' })
  assert.equal(r.code, 400); assert.equal(r.body.code, 'HOLIDAY'); assert.match(r.body.message, /Christmas Day/); assert.match(r.body.message, /Regular Holiday/)
})
test('HOLIDAY: verified 2026 dates are all blocked (Eid\'l Fitr, Labor Day, Eid\'l Adha, Independence Day, special non-working days)', () => {
  for (const [date, name] of [['2026-03-20', "Eid'l Fitr"], ['2026-05-01', 'Labor Day'], ['2026-05-27', "Eid'l Adha"], ['2026-06-12', 'Independence Day'], ['2026-02-17', 'Chinese New Year'], ['2026-11-02', "All Souls' Day"], ['2026-12-24', 'Christmas Eve']]) {
    const r = run({ reservation_date: date }); assert.equal(r.code, 400, date); assert.equal(r.body.code, 'HOLIDAY', date); assert.ok(r.body.message.includes(name), date)
  }
})
test('HOLIDAY: special WORKING day stays bookable (Feb 25, 2026 baseline + a future special working day through the controller)', () => {
  const baseline = PH.evaluateReservableDate('2026-02-25', PH.baselineForDate('2026-02-25'))
  assert.equal(baseline.ok, true); assert.equal(baseline.code, 'SPECIAL_WORKING'); assert.equal(baseline.holiday.name, 'EDSA People Power Revolution Anniversary')
  const r = run({ reservation_date: '2027-03-10' }, { holidayRows: [{ id: 5, holiday_date: '2027-03-10', name: 'Special Work Day', holiday_type: 'SPECIAL_WORKING', is_active: 1 }] })
  assert.notEqual(r.body?.code, 'HOLIDAY'); assert.equal(r.code, 201, JSON.stringify(r.body))
})
test('HOLIDAY: database row is authoritative - MIS-declared holiday blocks, deactivated baseline holiday opens', () => {
  const declared = run({ reservation_date: '2027-03-10' }, { holidayRows: [{ id: 9, holiday_date: '2027-03-10', name: 'Declared Suspension', holiday_type: 'SPECIAL_NON_WORKING', is_active: 1 }] })
  assert.equal(declared.code, 400); assert.match(declared.body.message, /Declared Suspension/)
  const removed = run({ reservation_date: '2026-12-25' }, { holidayRows: [{ id: 3, holiday_date: '2026-12-25', name: 'Christmas Day', holiday_type: 'REGULAR', is_active: 0 }] })
  assert.notEqual(removed.body?.code, 'HOLIDAY')
})
test('HOLIDAY: Sunday is still blocked even when it is a special working day row', () => {
  const r = run({ reservation_date: '2027-03-07' }, { holidayRows: [{ id: 4, holiday_date: '2027-03-07', name: 'Special Work Sunday', holiday_type: 'SPECIAL_WORKING', is_active: 1 }] })
  assert.equal(r.code, 400); assert.match(r.body.message, /Sunday/)
})


// ---- Half-day reservation periods (mocked DB; exercises the real controller code path) ----
const runWith = (opts, body, role = 'Teacher') => { const { controller, calls } = setup({ role, ...opts }), r = responseMock(); controller.createReservation(req(role, body), r); return { r, calls } }
const inserts = calls => calls.filter(c => typeof c === 'object' && c.insert)
test('TIME (CP23): explicit start/end times are used (30-minute increments); a legacy period alone still works', () => {
  const { r } = runWith({}, { period: undefined, start_time: '09:30', end_time: '12:00' })
  assert.equal(r.code, 201); assert.equal(r.body.reservation.start_time, '09:30:00'); assert.equal(r.body.reservation.end_time, '12:00:00')
  assert.equal(runWith({}, { period: 'MORNING', start_time: undefined, end_time: undefined }).r.body.reservation.start_time, '08:00:00')
})
test('TIME (CP23): missing, malformed or off-increment times are rejected with 400 and nothing is inserted', () => {
  for (const [start_time, end_time] of [[undefined, undefined], ['', ''], ['09:20', '10:45'], ['9:00', '10:00'], ['09:00', '09:00'], ['10:00', '09:00'], ['09:00; DROP', '10:00'], [['09:00'], '10:00'], [900, 1000]]) {
    const { r, calls } = runWith({}, { period: undefined, start_time, end_time }); assert.equal(r.code, 400, JSON.stringify([start_time, end_time])); assert.equal(inserts(calls).length, 0)
  }
})
test('PERIOD: conflict query is the real overlap predicate bound to (period end, period start) and runs after the lab row lock', () => {
  const { r, calls } = runWith({}, { period: 'AFTERNOON' }); assert.equal(r.code, 201)
  const lock = calls.findIndex(c => typeof c === 'string' && c.startsWith('SELECT id, status, available_from') && /FOR UPDATE/.test(c))
  const idx = calls.findIndex(c => typeof c === 'string' && c.startsWith('SELECT id, start_time, end_time FROM reservations'))
  assert.ok(lock >= 0 && idx > lock, 'lab row locked before conflict check'); assert.match(calls[idx], /start_time < \? AND end_time > \?/)
  assert.match(calls[idx], /'COMPLETED'/); assert.doesNotMatch(calls[idx], /'DECLINED'|'CANCELLED'/)
})
test('TIME (CP23): operating hours are 07:00-21:00 for every laboratory (per-lab hours no longer narrow them)', () => {
  const lab = { labFrom: '12:00:00', labUntil: '17:00:00' }
  assert.equal(runWith(lab, { period: undefined, start_time: '07:00', end_time: '09:00' }).r.code, 201)
  assert.equal(runWith(lab, { period: undefined, start_time: '19:00', end_time: '21:00' }).r.code, 201)
  const early = runWith(lab, { period: undefined, start_time: '06:30', end_time: '08:00' }); assert.equal(early.r.code, 400); assert.match(early.r.body.message, /operating hours/)
  assert.equal(runWith(lab, { period: undefined, start_time: '20:30', end_time: '21:30' }).r.code, 400)
})
test('CP81 PERIOD: a request for tomorrow is PENDING for either period', () => {
  for (const period of ['MORNING', 'AFTERNOON']) { const { r } = runWith({}, { period, reservation_date: futureDate(1) }); assert.equal(r.code, 201); assert.equal(r.body.auto_declined, false); assert.equal(r.body.reservation.status, 'PENDING') }
})
test('PERIOD: simulated race - another user books the slot between availability check and save -> 409, no insert, nothing committed', () => {
  const { r, calls } = runWith({ conflicts: [{ id: 77, start_time: '08:00:00', end_time: '12:00:00' }] }, { period: 'MORNING' })
  assert.equal(r.code, 409); assert.equal(r.body.code, 'SLOT_TAKEN'); assert.equal(inserts(calls).length, 0); assert.ok(!calls.includes('COMMIT'))
})
test('PERIOD: validateReservationWindow is exported and pure', () => {
  const { controller } = setup(); const v = controller.validateReservationWindow
  assert.equal(v('08:00', '12:00', '08:00', '17:00').ok, true); assert.equal(v('08:00', '12:00', '12:00', '17:00').ok, false)
})
