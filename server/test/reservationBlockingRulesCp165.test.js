// CP165 (Part 1): only APPROVED and COMPLETED reservations block a NEW request; PENDING reservations may overlap freely; back-to-back
// (half-open) requests are allowed; operating hours stay 7:00 AM-9:00 PM. The rule must NOT depend on the CLMS_CONFLICT_STATUSES
// environment setting. Offline: the real controller runs against a stateful in-memory stand-in (not MySQL, not a live database);
// the half-open overlap and status filter are additionally run as REAL SQL on node:sqlite (SQLite, not MySQL/MariaDB).
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

const ENV_KEY = 'CLMS_CONFLICT_STATUSES'
const policyPath = path.resolve(__dirname, '../config/reservationPolicy.js')
function withEnv(value, fn) {
  const before = process.env[ENV_KEY]
  if (value === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = value
  delete require.cache[policyPath]
  try { return fn() } finally { if (before === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = before; delete require.cache[policyPath] }
}

// Hostile settings that used to change what blocks a new request (APPROVED could drop out; DECLINED/CANCELLED could be added).
for (const env of [undefined, 'PENDING,APPROVED', 'PENDING', 'DECLINED', 'COMPLETED', 'PENDING,APPROVED,DECLINED,CANCELLED,COMPLETED']) {
  test(`new-request blocking is exactly APPROVED + COMPLETED with ${ENV_KEY}=${env === undefined ? '(unset)' : env}`, () => withEnv(env, () => {
    const w = makeWorld({ existing: [
      { reserved_by: 7, start_time: '08:00:00', end_time: '09:00:00', status: 'DECLINED' },
      { reserved_by: 7, start_time: '10:00:00', end_time: '11:00:00', status: 'APPROVED' },
      { reserved_by: 7, start_time: '13:00:00', end_time: '14:00:00', status: 'COMPLETED' },
      { reserved_by: 7, start_time: '15:00:00', end_time: '16:00:00', status: 'PENDING' },
      { reserved_by: 7, start_time: '16:00:00', end_time: '17:00:00', status: 'CANCELLED' }
    ] })
    assert.equal(w.controller.NEW_REQUEST_BLOCKING_SQL, "'APPROVED','COMPLETED'")
    // Rules 1-2: PENDING never blocks; several PENDING requests may overlap the same lab/date/time (identical, partial, other teacher).
    for (const [user, s, e] of [[8, '15:00', '16:00'], [9, '15:00', '16:00'], [8, '15:30', '16:00'], [10, '14:30', '15:30']]) { const r = submit(w, user, s, e); assert.equal(r.code, 201, `${s}-${e} ${JSON.stringify(r.body)}`); assert.equal(r.body.reservation.status, 'PENDING') }
    // DECLINED / CANCELLED are not blocking either.
    assert.equal(submit(w, 8, '08:00', '09:00').code, 201); assert.equal(submit(w, 8, '16:00', '17:00').code, 201)
    // Rule 3: APPROVED and COMPLETED block (partial, inside, containing, identical).
    const before = w.table.length
    for (const [s, e] of [['10:30', '11:30'], ['09:30', '10:30'], ['10:00', '11:00'], ['09:00', '12:00'], ['10:30', '11:00'], ['13:30', '14:30'], ['13:00', '14:00']]) { const r = submit(w, 8, s, e); assert.equal(r.code, 409, `${s}-${e}`); assert.equal(r.body.code, 'SLOT_TAKEN') }
    assert.equal(w.table.length, before, 'rejected requests insert nothing')
    // Rule 4: half-open intervals - back-to-back with an APPROVED / COMPLETED reservation is allowed on both sides.
    for (const [s, e] of [['11:00', '12:00'], ['09:00', '10:00'], ['14:00', '15:00'], ['12:00', '13:00']]) assert.equal(submit(w, 8, s, e).code, 201, `${s}-${e}`)
  }))
}

test('the controller still rejects times outside 7:00 AM-9:00 PM and keeps 30-minute steps (rule 5 unchanged)', () => withEnv(undefined, () => {
  const T = require('../config/reservationTime.js')
  assert.equal(T.timeOptions()[0], '07:00'); assert.equal(T.timeOptions().at(-1), '21:00')
  assert.equal(T.validateTimeRange('07:00', '08:00').ok, true); assert.equal(T.validateTimeRange('20:00', '21:00').ok, true)
  for (const [s, e] of [['06:30', '07:30'], ['20:30', '21:30'], ['06:00', '07:00'], ['21:00', '22:00'], ['07:15', '08:00'], ['09:00', '09:00'], ['10:00', '09:00']]) assert.equal(T.validateTimeRange(s, e).ok, false, `${s}-${e}`)
  const w = makeWorld()
  for (const [s, e] of [['06:30', '07:30'], ['20:30', '21:30'], ['09:15', '10:00']]) { const r = submit(w, 8, s, e); assert.equal(r.code, 400, `${s}-${e}`); assert.equal(w.table.length, 0) }
}))

test('SQLITE (real SQL): controller OVERLAP_SQL is half-open and NEW_REQUEST_BLOCKING_SQL selects only APPROVED/COMPLETED', () => withEnv('PENDING,APPROVED,DECLINED,CANCELLED', () => {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE reservations (id INTEGER PRIMARY KEY, laboratory_id INT, reservation_date TEXT, start_time TEXT, end_time TEXT, status TEXT)')
  const add = (s, e, st, lab = 1) => db.prepare('INSERT INTO reservations (laboratory_id, reservation_date, start_time, end_time, status) VALUES (?,?,?,?,?)').run(lab, '2026-12-01', s, e, st)
  for (const st of ['PENDING', 'PENDING', 'DECLINED', 'CANCELLED']) add('09:00:00', '11:00:00', st)
  add('13:00:00', '15:00:00', 'APPROVED'); add('16:00:00', '17:00:00', 'COMPLETED'); add('13:00:00', '15:00:00', 'APPROVED', 2)
  const c = makeWorld().controller
  const hit = (s, e) => db.prepare(`SELECT id FROM reservations WHERE laboratory_id = 1 AND reservation_date = '2026-12-01' AND status IN (${c.NEW_REQUEST_BLOCKING_SQL}) AND ${c.OVERLAP_SQL}`).all(e, s).length
  assert.equal(hit('09:30:00', '10:30:00'), 0, 'PENDING / DECLINED / CANCELLED rows do not block')
  assert.equal(hit('14:00:00', '14:30:00'), 1, 'APPROVED blocks'); assert.equal(hit('16:30:00', '18:00:00'), 1, 'COMPLETED blocks')
  assert.equal(hit('15:00:00', '16:00:00'), 0, 'back-to-back on both sides (APPROVED ends 15:00, COMPLETED starts 16:00)')
  assert.equal(hit('11:00:00', '13:00:00'), 0); assert.equal(hit('12:00:00', '13:00:00'), 0, 'ends exactly when APPROVED starts'); assert.equal(hit('15:00:00', '15:30:00'), 0, 'starts exactly when APPROVED ends')
  assert.equal(hit('12:59:00', '13:01:00'), 1, 'a one-minute overlap is still a conflict')
}))

test('source: create, availability and approval checks use the fixed list; approval/undo flows that count PENDING are untouched', () => {
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '../controllers/reservationController.js'), 'utf8')
  assert.match(src, /NEW_REQUEST_BLOCKING_STATUSES = Object\.freeze\(\['APPROVED', 'COMPLETED'\]\)/)
  assert.equal((src.match(/status IN \(\$\{NEW_REQUEST_BLOCKING_SQL\}\)/g) || []).length, 3)
  assert.doesNotMatch(src, /const NEW_REQUEST_BLOCKING_SQL = \[\.\.\.new Set/, 'no longer derived from the environment-configurable list')
  assert.match(src, /OVERLAP_SQL = 'start_time < \? AND end_time > \?'/)
})
