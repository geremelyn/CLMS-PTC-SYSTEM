// CP105A (Sir JC): an overlapping PENDING request must not block a new request. Offline: the controller runs for real against a stateful
// in-memory stand-in that evaluates the conflict SQL's status list and the overlap parameters (not MySQL, not a live database).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const PH = require('../utils/philippineHolidays.js')

function futureDate(days) { const d = new Date(Date.now() + days * 86400000); const closed = () => d.getUTCDay() === 0 || PH.evaluateReservableDate(d.toISOString().slice(0, 10), PH.baselineForDate(d.toISOString().slice(0, 10)), []).ok === false; while (closed()) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
const DATE = futureDate(12)

function makeWorld({ existing = [], labStatus = 'OPEN' } = {}) {
  const table = existing.map((r, i) => ({ id: 100 + i, laboratory_id: 1, reservation_date: DATE, ...r }))
  let nextId = 500
  const world = { role: 'Teacher' }
  const conn = {
    beginTransaction: cb => cb(null), commit: cb => cb(null), rollback: cb => cb(null), release() {},
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim()
      if (n.startsWith('SELECT id, status, available_from')) return cb(null, [{ id: 1, status: labStatus, available_from: '08:00:00', available_until: '17:00:00', booking_interval: 60 }])
      if (n.startsWith('SELECT id, start_time, end_time FROM reservations')) {
        const statuses = (n.match(/status IN \(([^)]*)\)/)[1] || '').split(',').map(v => v.replace(/'/g, '').trim())
        const [labId, date, endBound, startBound] = values // OVERLAP_SQL: start_time < ? AND end_time > ?
        return cb(null, table.filter(r => r.laboratory_id === labId && r.reservation_date === date && statuses.includes(r.status) && r.start_time < endBound && r.end_time > startBound))
      }
      if (n.startsWith('INSERT INTO reservations')) { const [laboratory_id, reserved_by, reservation_date, start_time, end_time, , , , status] = values; table.push({ id: nextId++, laboratory_id, reserved_by, reservation_date, start_time, end_time, status }); return cb(null, { insertId: nextId - 1 }) }
      throw new Error('Unexpected SQL: ' + n)
    }
  }
  const pool = {
    query(sql, values, cb) {
      if (/FROM users/.test(sql)) return cb(null, [{ id: values[0], full_name: 'User ' + values[0], role: world.role, status: 'ACTIVE' }])
      if (/FROM holidays/.test(sql)) return cb(null, [])
      if (/FROM laboratories/.test(sql)) return cb(null, [{ id: 1, laboratory_name: 'Laboratory 1', status: labStatus, available_from: '08:00:00', available_until: '17:00:00' }])
      if (/FROM reservations/.test(sql)) { const statuses = sql.match(/status IN \(([^)]*)\)/)[1].replace(/'/g, '').split(',').map(v => v.trim()); return cb(null, table.filter(r => r.laboratory_id === values[0] && r.reservation_date === values[1] && statuses.includes(r.status)).map(r => ({ id: r.id, start_time: r.start_time, end_time: r.end_time }))) }
      throw new Error('Unexpected pool SQL: ' + sql)
    },
    getConnection(cb) { cb(null, conn) }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), cPath = path.resolve(__dirname, '../controllers/reservationController.js')
  for (const [p, exp] of [[dbPath, pool], [auditPath, { logAudit() {} }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[cPath]
  return { controller: require(cPath), table, world }
}
const res = () => ({ code: 200, body: null, headersSent: false, status(c) { this.code = c; return this }, json(b) { this.body = b; this.headersSent = true; return this } })
const submit = (w, userId, start_time, end_time, role = 'Teacher') => { w.world.role = role; const r = res(); w.controller.createReservation({ user: { id: userId, role }, body: { laboratory_id: 1, reservation_date: DATE, start_time, end_time, purpose: 'Lecture', subject_name: 'IT101', professor_name: 'Prof. Cruz' } }, r); return r }
const availability = async (w) => { const r = res(); await w.controller.getPeriodAvailability({ query: { date: DATE, laboratory_id: 1 }, user: { id: 7, role: 'Teacher' } }, r); return r }

test('two overlapping PENDING requests (same teacher) can both be submitted', () => {
  const w = makeWorld()
  assert.equal(submit(w, 7, '09:00', '11:00').code, 201)
  const second = submit(w, 7, '10:00', '12:00'); assert.equal(second.code, 201, JSON.stringify(second.body)); assert.equal(second.body.reservation.status, 'PENDING')
  assert.equal(w.table.filter(r => r.status === 'PENDING').length, 2)
})
test('overlapping PENDING from ANOTHER teacher is accepted; identical time range too', () => {
  const w = makeWorld({ existing: [{ reserved_by: 7, start_time: '08:00:00', end_time: '12:00:00', status: 'PENDING' }] })
  assert.equal(submit(w, 8, '09:00', '10:00').code, 201); assert.equal(submit(w, 9, '08:00', '12:00').code, 201)
})
test('non-overlapping and back-to-back requests still work', () => {
  const w = makeWorld({ existing: [{ reserved_by: 7, start_time: '09:00:00', end_time: '10:00:00', status: 'APPROVED' }, { reserved_by: 7, start_time: '13:00:00', end_time: '14:00:00', status: 'PENDING' }] })
  assert.equal(submit(w, 8, '14:00', '15:00').code, 201, 'starts when PENDING ends')
  assert.equal(submit(w, 8, '10:00', '11:00').code, 201, 'starts when APPROVED ends')
  assert.equal(submit(w, 8, '08:00', '09:00').code, 201, 'ends when APPROVED starts')
  assert.equal(submit(w, 8, '15:00', '17:00').code, 201, 'far from everything')
})
test('overlap with an APPROVED reservation is still rejected (409 SLOT_TAKEN), nothing inserted', () => {
  const w = makeWorld({ existing: [{ reserved_by: 7, start_time: '09:00:00', end_time: '11:00:00', status: 'APPROVED' }] })
  for (const [s, e] of [['10:00', '12:00'], ['08:00', '10:00'], ['09:00', '11:00'], ['09:30', '10:30'], ['08:00', '12:00']]) { const r = submit(w, 8, s, e); assert.equal(r.code, 409, s + '-' + e); assert.equal(r.body.code, 'SLOT_TAKEN') }
  assert.equal(w.table.length, 1)
})
test('COMPLETED overlap still blocks; DECLINED / CANCELLED never blocked (unchanged)', () => {
  const w = makeWorld({ existing: [{ reserved_by: 7, start_time: '09:00:00', end_time: '11:00:00', status: 'COMPLETED' }, { reserved_by: 7, start_time: '13:00:00', end_time: '15:00:00', status: 'DECLINED' }, { reserved_by: 7, start_time: '15:00:00', end_time: '17:00:00', status: 'CANCELLED' }] })
  assert.equal(submit(w, 8, '10:00', '12:00').code, 409)
  assert.equal(submit(w, 8, '13:00', '15:00').code, 201); assert.equal(submit(w, 8, '15:00', '17:00').code, 201)
})
test('other validations and permissions intact: closed lab 400, bad times 400, forbidden role rejected, PENDING never auto-approved', () => {
  const closed = makeWorld({ labStatus: 'CLOSED' }); assert.equal(submit(closed, 7, '09:00', '10:00').code, 400)
  const w = makeWorld()
  assert.equal(submit(w, 7, '09:20', '10:45').code, 400); assert.equal(submit(w, 7, '10:00', '09:00').code, 400)
  assert.equal(submit(w, 7, '09:00', '10:00', 'Inventory Staff').code, 403, 'MIS Staff still cannot submit (role gate unchanged)')
  assert.equal(w.table.length, 0)
  
  const ok = submit(w, 7, '09:00', '10:00'); assert.equal(ok.body.reservation.status, 'PENDING')
})
test('availability: a PENDING request no longer marks the period occupied, an APPROVED one still does', async () => {
  const pending = await availability(makeWorld({ existing: [{ reserved_by: 7, start_time: '08:00:00', end_time: '12:00:00', status: 'PENDING' }] }))
  assert.equal(pending.code, 200); assert.equal(pending.body.periods.find(p => p.period === 'MORNING').available, true)
  const approved = await availability(makeWorld({ existing: [{ reserved_by: 7, start_time: '08:00:00', end_time: '12:00:00', status: 'APPROVED' }] }))
  assert.equal(approved.body.periods.find(p => p.period === 'MORNING').available, false)
})
test('source: create + availability use the non-PENDING list; approval/undo conflict checks and BLOCKING_STATUS_SQL are untouched', () => {
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '../controllers/reservationController.js'), 'utf8')
  assert.equal((src.match(/status IN \(\$\{NEW_REQUEST_BLOCKING_SQL\}\)/g) || []).length, 3) // create + availability (CP105A) + approval check (CP105B)
  assert.ok(/AND id <> \? AND status IN \(\$\{RESERVATION_POLICY\.conflictStatusSql\}\)/.test(src), 'approval-time conflict check still counts PENDING (CP105B)')
  const c = require('../controllers/reservationController.js'); assert.ok(!c.NEW_REQUEST_BLOCKING_SQL.includes('PENDING')); assert.ok(c.NEW_REQUEST_BLOCKING_SQL.includes('APPROVED') && c.NEW_REQUEST_BLOCKING_SQL.includes('COMPLETED')); assert.ok(c.BLOCKING_STATUS_SQL.includes('PENDING'))
})
