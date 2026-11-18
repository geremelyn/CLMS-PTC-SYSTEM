'use strict'
// CP24: contract tests for the Dean/Teacher custom start/end time form (client/src/pages/Reservations.jsx).
// MOCKED db (same stand-in style as reservationCreateController.test.js); real overlap SQL is covered by overlapSqlReal.test.js (SQLite).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')
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


// Exactly the payload shape Reservations.jsx sends (no `period`; professor from the logged-in account).
function payload(over = {}) { return { laboratory_id: 1, reserved_by: 7, reservation_date: futureDate(10), start_time: '09:00', end_time: '12:00', purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Maria Cruz', ...over } }
const reqAs = (role, body) => ({ user: { id: 7, role }, body })
const inserted = calls => calls.find(c => c && typeof c === 'object' && c.insert)?.insert

for (const role of ['Dean', 'Teacher']) {
  test(`${role}: selected start_time/end_time reach the INSERT unchanged (multi-hour, not 30-minute fixed)`, () => {
    const { controller, calls } = setup({ role }), response = responseMock()
    controller.createReservation(reqAs(role, payload({ start_time: '09:00', end_time: '14:30' })), response)
    assert.equal(response.code, 201, JSON.stringify(response.body))
    assert.equal(response.body.period, 'CUSTOM')
    assert.equal(response.body.reservation.start_time, '09:00:00'); assert.equal(response.body.reservation.end_time, '14:30:00')
    const values = inserted(calls); assert.ok(values.includes('09:00:00') && values.includes('14:30:00') && values.includes('Maria Cruz'))
  })
}
test('whole operating day 07:00-21:00 and a single 30-minute block are both accepted', () => {
  for (const [s, e] of [['07:00', '21:00'], ['20:30', '21:00'], ['07:00', '07:30']]) {
    const { controller } = setup(), response = responseMock()
    controller.createReservation(reqAs('Teacher', payload({ start_time: s, end_time: e })), response)
    assert.equal(response.code, 201, `${s}-${e} ${JSON.stringify(response.body)}`)
  }
})
test('Morning/Afternoon presets are only UI shortcuts: a range crossing 12:00 is accepted', () => {
  const { controller } = setup(), response = responseMock()
  controller.createReservation(reqAs('Dean', payload({ start_time: '10:00', end_time: '15:00' })), response)
  assert.equal(response.code, 201)
})
test('invalid times are rejected with a readable 400 and nothing is inserted', () => {
  const cases = [['06:30', '09:00', /operating hours/i], ['20:00', '21:30', /operating hours/i], ['09:15', '10:00', /30-minute/], ['10:00', '10:00', /later than/i], ['11:00', '09:00', /later than/i], ['', '10:00', /valid start and end/i]]
  for (const [s, e, pattern] of cases) {
    const { controller, calls } = setup(), response = responseMock()
    controller.createReservation(reqAs('Teacher', payload({ start_time: s, end_time: e })), response)
    assert.equal(response.code, 400, `${s}-${e}`); assert.match(response.body.message, pattern); assert.equal(inserted(calls), undefined)
  }
})
test('an overlapping reservation returns 409 SLOT_TAKEN with the chosen times in the message, rolls back, inserts nothing', () => {
  const { controller, calls } = setup({ conflicts: [{ id: 3, start_time: '10:00:00', end_time: '11:00:00' }] }), response = responseMock()
  controller.createReservation(reqAs('Dean', payload({ start_time: '09:00', end_time: '12:00' })), response)
  assert.equal(response.code, 409); assert.equal(response.body.code, 'SLOT_TAKEN'); assert.match(response.body.message, /9:00 AM – 12:00 PM overlaps/)
  assert.ok(calls.includes('ROLLBACK')); assert.equal(inserted(calls), undefined)
})
test('conflict query uses exact-time overlap and only blocking statuses (APPROVED/COMPLETED; CP105A: not PENDING); DECLINED/CANCELLED are not selected', () => {
  const { controller, calls } = setup(), response = responseMock()
  controller.createReservation(reqAs('Teacher', payload()), response)
  const q = calls.find(c => typeof c === 'string' && c.startsWith('SELECT id, start_time, end_time FROM reservations'))
  assert.match(q, /start_time < \? AND end_time > \?/); assert.doesNotMatch(q, /PENDING/); assert.match(q, /APPROVED/); assert.doesNotMatch(q, /DECLINED|CANCELLED/)
})
test('legacy clients that send only `period` still work (backward compatible)', () => {
  const { controller } = setup(), response = responseMock()
  const body = payload(); delete body.start_time; delete body.end_time; body.period = 'MORNING'
  controller.createReservation(reqAs('Teacher', body), response)
  assert.equal(response.code, 201); assert.equal(response.body.reservation.start_time, '08:00:00')
})

// ---- frontend contract (source-level, because the JSX page cannot be rendered without Vite/Chromium) ----
const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Reservations.jsx'), 'utf8')
test('Reservations.jsx posts start_time/end_time and takes professor_name from the logged-in account', () => {
  const post = page.slice(page.indexOf('async function handleCreateReservation'), page.indexOf('// CANCEL RESERVATION'))
  assert.match(post, /start_time:\s*startTime/); assert.match(post, /end_time:\s*endTime/); assert.match(post, /professor_name:\s*professor\.name/)
  assert.doesNotMatch(post, /\bperiod:\s*\n?\s*selectedPeriod/)
  assert.doesNotMatch(page, /setProfessorName|Professor's full name/)
})
test('only Subject Name and Purpose are typed; professor field is read-only', () => {
  assert.match(page, /readOnly value=\{professor\.name/)
  assert.equal((page.match(/onChange=\{event => setSubjectName/g) || []).length, 1); assert.equal((page.match(/onChange=\{event => setPurpose/g) || []).length, 1)
})
test('Save is not gated on a Morning/Afternoon availability flag', () => {
  assert.doesNotMatch(page, /disabled=\{saving \|\| availabilityLoading \|\| !selectedPeriod\}/)
  assert.doesNotMatch(page, /any_available/)
})

// ---- client helper (ESM) ----
test('client time helpers: 07:00-21:00 in 30-minute steps, end options after start, closed-day vs partly-booked', async () => {
  const h = await import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/reservationTime.js')).href)
  assert.equal(h.TIME_OPTIONS[0], '07:00'); assert.equal(h.TIME_OPTIONS.at(-1), '21:00'); assert.equal(h.TIME_OPTIONS.length, 29)
  assert.ok(!h.START_OPTIONS.includes('21:00')); assert.deepEqual(h.endOptionsFor('20:00'), ['20:30', '21:00'])
  assert.equal(h.formatTimeLabel('13:30'), '1:30 PM'); assert.equal(h.formatTimeLabel('00:00'), '12:00 AM')
  assert.equal(h.isDateClosed({ periods: [{ reason: 'SUNDAY' }, { reason: 'SUNDAY' }] }), true)
  assert.equal(h.isDateClosed({ periods: [{ reason: 'OCCUPIED' }, { reason: 'OCCUPIED' }] }), false) // both parts partly booked != closed
  assert.match(h.busyNote({ periods: [{ reason: 'OCCUPIED', label: 'Morning' }, { reason: null, label: 'Afternoon' }] }), /morning/)
  assert.deepEqual(h.describeProfessor({ full_name: ' Maria Cruz ', role: 'Dean' }), { name: 'Maria Cruz', role: 'Dean' })
})
