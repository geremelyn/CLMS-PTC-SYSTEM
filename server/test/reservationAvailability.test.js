// Availability endpoint + double-booking tests.
// REAL SQL: node:sqlite executes the exact BLOCKING_STATUS_SQL / OVERLAP_SQL predicates (SQLite, NOT MySQL/MariaDB).
// MOCKED: the Express handler/db driver and the "two users" race (a shared in-memory table with a serialized lab lock).
// Actual MySQL/MariaDB row locking (FOR UPDATE) is NOT exercised here - see docs/HALF_DAY_RESERVATION_TEST_PLAN.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
let DatabaseSync
try { ({ DatabaseSync } = require('node:sqlite')) } catch { /* older Node */ }
const skip = !DatabaseSync && 'node:sqlite unavailable'
const PH = require('../utils/philippineHolidays.js')
function futureDate(days) { let d = new Date(Date.now() + days * 86400000); const bad = x => x.getUTCDay() === 0 || !PH.evaluateReservableDate(x.toISOString().slice(0, 10), PH.baselineForDate(x.toISOString().slice(0, 10))).ok; while (bad(d)) d = new Date(d.getTime() + 86400000); return d.toISOString().slice(0, 10) }
const DATE = futureDate(20), DATE2 = futureDate(25)

// ---- shared in-memory "database" backed by real SQLite so the SQL predicates are really evaluated ----
function makeDb(rows = []) {
  const sql = new DatabaseSync(':memory:')
  sql.exec('CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, laboratory_id INT, reservation_date TEXT, start_time TEXT, end_time TEXT, status TEXT)')
  const add = (lab, date, st, en, status = 'APPROVED') => Number(sql.prepare('INSERT INTO reservations (laboratory_id, reservation_date, start_time, end_time, status) VALUES (?,?,?,?,?)').run(lab, date, st, en, status).lastInsertRowid)
  for (const r of rows) add(...r)
  const labs = { 1: { id: 1, status: 'OPEN', available_from: '08:00:00', available_until: '17:00:00', laboratory_name: 'Lab 1' }, 2: { id: 2, status: 'OPEN', available_from: '08:00:00', available_until: '17:00:00', laboratory_name: 'Lab 2' } }
  let lockQueue = Promise.resolve()
  const exec = (n, values) => {
    if (/FROM laboratories WHERE id = \?$/.test(n) && n.startsWith('SELECT id, status, available_from, available_until FROM')) return [labs[values[0]]].filter(Boolean)
    if (n.startsWith('SELECT id, status, available_from, available_until, booking_interval')) return [labs[values[0]]].filter(Boolean)
    if (/^SELECT .* FROM reservations/.test(n)) return sql.prepare(n.replace(/ FOR UPDATE$/, '')).all(...values.map(v => v))
    if (n.startsWith('INSERT INTO reservations')) { const [lab, , date, st, en, , , , status] = values; return { insertId: add(lab, date, st, en, status) } }
    if (/FROM users/.test(n)) return [{ id: 7, full_name: 'T', role: 'Teacher', status: 'ACTIVE' }]
    if (/FROM holidays/.test(n)) return []
    if (/FROM laboratories/.test(n)) return [labs[values[0]]].filter(Boolean)
    throw new Error('Unexpected SQL ' + n)
  }
  const norm = q => q.replace(/\s+/g, ' ').trim()
  const pool = {
    query(q, v, cb) { if (typeof v === 'function') { cb = v; v = [] } try { const r = exec(norm(q), v || []); setImmediate(() => cb(null, r)) } catch (e) { setImmediate(() => cb(e)) } },
    getConnection(cb) {
      let release
      const conn = {
        // Simulated lab-row lock: `FOR UPDATE` on laboratories serializes transactions until commit/rollback/release.
        beginTransaction(c) { c(null) },
        query(q, v, c) {
          const n = norm(q)
          const run = () => { try { const r = exec(n, v || []); setImmediate(() => c(null, r)) } catch (e) { setImmediate(() => c(e)) } }
          if (/FROM laboratories WHERE id = \? FOR UPDATE/.test(n)) { const prev = lockQueue; lockQueue = new Promise(res => { release = res }); prev.then(run) } else run()
        },
        commit(c) { c(null); release && release() }, rollback(c) { c(null); release && release() }, release() { release && release() }
      }
      cb(null, conn)
    }
  }
  return { sql, add, pool }
}
function load(pool) {
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), cPath = path.resolve(__dirname, '../controllers/reservationController.js')
  for (const [p, exp] of [[dbPath, pool], [auditPath, { logAudit() {} }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[cPath]; return require(cPath)
}
const res = () => ({ code: 200, body: null, headersSent: false, status(c) { this.code = c; return this }, json(b) { this.body = b; this.headersSent = true; return this } })
const call = (fn, req) => new Promise(resolve => { const r = res(); const orig = r.json.bind(r); r.json = b => { orig(b); resolve(r); return r }; fn(req, r) })
const availability = async (c, lab, date) => { const r = res(); await c.getPeriodAvailability({ query: { laboratory_id: String(lab), date } }, r); return r }
const flags = r => Object.fromEntries(r.body.periods.map(p => [p.period, p.available]))
const create = (c, body) => call(c.createReservation, { user: { id: 7, role: 'Teacher' }, body: { laboratory_id: 1, reservation_date: DATE, purpose: 'x', subject_name: 'S', professor_name: 'P', ...body } })

test('availability: nothing booked -> both periods available', { skip }, async () => { const { pool } = makeDb(); const r = await availability(load(pool), 1, DATE); assert.equal(r.code, 200); assert.deepEqual(flags(r), { MORNING: true, AFTERNOON: true }); assert.equal(r.body.message, '') })
test('availability: Morning booked -> only Morning disabled', { skip }, async () => { const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00']]); assert.deepEqual(flags(await availability(load(pool), 1, DATE)), { MORNING: false, AFTERNOON: true }) })
test('availability: Afternoon booked -> only Afternoon disabled', { skip }, async () => { const { pool } = makeDb([[1, DATE, '12:00:00', '17:00:00', 'APPROVED']]); assert.deepEqual(flags(await availability(load(pool), 1, DATE)), { MORNING: true, AFTERNOON: false }) })
test('availability: both booked -> both disabled with a clear message', { skip }, async () => { const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00'], [1, DATE, '12:00:00', '17:00:00']]); const r = await availability(load(pool), 1, DATE); assert.deepEqual(flags(r), { MORNING: false, AFTERNOON: false }); assert.match(r.body.message, /Both Morning and Afternoon are already reserved/); assert.equal(r.body.any_available, false) })
test('availability: independent per laboratory and per date', { skip }, async () => { const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00']]); const c = load(pool); assert.deepEqual(flags(await availability(c, 2, DATE)), { MORNING: true, AFTERNOON: true }); assert.deepEqual(flags(await availability(c, 1, DATE2)), { MORNING: true, AFTERNOON: true }) })
test('availability: legacy reservations block by real overlap (one or both periods)', { skip }, async () => {
  for (const [st, en, exp] of [['09:15:00', '10:45:00', { MORNING: false, AFTERNOON: true }], ['13:00:00', '15:00:00', { MORNING: true, AFTERNOON: false }], ['11:00:00', '13:00:00', { MORNING: false, AFTERNOON: false }], ['07:00:00', '08:00:00', { MORNING: true, AFTERNOON: true }]]) {
    const { pool } = makeDb([[1, DATE, st, en]]); assert.deepEqual(flags(await availability(load(pool), 1, DATE)), exp, `${st}-${en}`)
  }
})
test('availability: DECLINED, CANCELLED and (CP105A) PENDING do not block; APPROVED and COMPLETED do', { skip }, async () => {
  for (const [status, blocks] of [['DECLINED', false], ['CANCELLED', false], ['PENDING', false], ['APPROVED', true], ['COMPLETED', true]]) {
    const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00', status]]); assert.equal(flags(await availability(load(pool), 1, DATE)).MORNING, !blocks, status)
  }
})
test('availability: a deleted (recycled) reservation no longer occupies the slot', { skip }, async () => { const { pool, sql } = makeDb([[1, DATE, '08:00:00', '12:00:00']]); const c = load(pool); assert.equal(flags(await availability(c, 1, DATE)).MORNING, false); sql.exec('DELETE FROM reservations'); assert.equal(flags(await availability(c, 1, DATE)).MORNING, true) })
test('availability: Sunday, past date and invalid input', { skip }, async () => {
  const { pool } = makeDb(); const c = load(pool); let sun = new Date(Date.now() + 30 * 86400000); while (sun.getUTCDay() !== 0) sun = new Date(sun.getTime() + 86400000)
  const r = await availability(c, 1, sun.toISOString().slice(0, 10)); assert.equal(r.body.any_available, false); assert.match(r.body.message, /Sunday/)
  assert.equal((await availability(c, 1, '2020-01-01')).body.any_available, false); assert.equal((await availability(c, 1, 'nope')).code, 400); assert.equal((await availability(c, 0, DATE)).code, 400)
})
test('create: saving into an occupied period is rejected with 409 (frontend disabling is not relied upon)', { skip }, async () => {
  const { pool, sql } = makeDb([[1, DATE, '08:00:00', '12:00:00']]); const c = load(pool)
  const r = await create(c, { period: 'MORNING' }); assert.equal(r.code, 409); assert.equal(r.body.code, 'SLOT_TAKEN'); assert.equal(sql.prepare('SELECT COUNT(*) n FROM reservations').get().n, 1)
  const ok = await create(c, { period: 'AFTERNOON' }); assert.equal(ok.code, 201); assert.equal(sql.prepare("SELECT start_time s, end_time e FROM reservations WHERE id=?").get(ok.body.reservation.id).s, '12:00:00')
})
test('create: legacy crossing-noon reservation blocks both Morning and Afternoon on create', { skip }, async () => {
  const { pool } = makeDb([[1, DATE, '11:00:00', '13:00:00']]); const c = load(pool)
  assert.equal((await create(c, { period: 'MORNING' })).code, 409); assert.equal((await create(c, { period: 'AFTERNOON' })).code, 409)
})
test('create: DECLINED/CANCELLED history does not block a new booking', { skip }, async () => {
  const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00', 'DECLINED'], [1, DATE, '12:00:00', '17:00:00', 'CANCELLED']]); const c = load(pool)
  assert.equal((await create(c, { period: 'MORNING' })).code, 201); assert.equal((await create(c, { period: 'AFTERNOON' })).code, 201)
})
test('create: other laboratory and other date are independent', { skip }, async () => {
  const { pool } = makeDb([[1, DATE, '08:00:00', '12:00:00']]); const c = load(pool)
  assert.equal((await create(c, { period: 'MORNING', laboratory_id: 2 })).code, 201); assert.equal((await create(c, { period: 'MORNING', reservation_date: DATE2 })).code, 201)
})
test('SIMULATED race (CP105A): ten simultaneous requests for one lab/date/period are all accepted as PENDING (overlapping PENDING is allowed)', { skip }, async () => {
  const { pool, sql } = makeDb(); const c = load(pool)
  const results = await Promise.all(Array.from({ length: 10 }, () => create(c, { period: 'MORNING' })))
  assert.equal(results.filter(r => r.code === 201).length, 10); assert.equal(results.filter(r => r.code === 409).length, 0)
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM reservations WHERE status = 'PENDING'").get().n, 10)
})
test('SIMULATED race: Morning and Afternoon requested at the same moment both succeed', { skip }, async () => {
  const { pool, sql } = makeDb(); const c = load(pool)
  const rs = await Promise.all([create(c, { period: 'MORNING' }), create(c, { period: 'AFTERNOON' }), create(c, { period: 'MORNING' })])
  assert.deepEqual(rs.map(r => r.code).sort(), [201, 201, 201]); assert.equal(sql.prepare('SELECT COUNT(*) n FROM reservations').get().n, 3)
})
test('SIMULATED: slot taken (APPROVED) after the user viewed availability but before Save -> 409, then refreshed availability shows it disabled', { skip }, async () => {
  const { pool, sql } = makeDb(); const c = load(pool)
  assert.deepEqual(flags(await availability(c, 1, DATE)), { MORNING: true, AFTERNOON: true })
  const b = await create(c, { period: 'MORNING' }); assert.equal(b.code, 201)   // user B saves first (PENDING)
  assert.equal((await create(c, { period: 'MORNING' })).code, 201)   // CP105A: a PENDING request does not block user A
  assert.deepEqual(flags(await availability(c, 1, DATE)), { MORNING: true, AFTERNOON: true })
  sql.prepare("UPDATE reservations SET status = 'APPROVED'").run()   // MIS approves -> now it is taken
  const late = await create(c, { period: 'MORNING' }); assert.equal(late.code, 409)   // user A saves late
  assert.deepEqual(flags(await availability(c, 1, DATE)), { MORNING: false, AFTERNOON: true })
})
