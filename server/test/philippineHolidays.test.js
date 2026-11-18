const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const PH = require('../utils/philippineHolidays.js')

test('2026 verified list: counts, types and the dates confirmed from Proclamation Nos. 1006 / 1189 / 1264 / 1447', () => {
  const list = PH.baselineForYear(2026), by = d => list.find(h => h.holiday_date === d)
  assert.equal(list.filter(h => h.holiday_type === 'REGULAR').length, 12)
  assert.equal(list.filter(h => h.holiday_type === 'SPECIAL_NON_WORKING').length, 11, '8 national + 3 NCR-only (Proc. 1447)')
  assert.equal(list.filter(h => h.holiday_type === 'SPECIAL_WORKING').length, 1)
  assert.ok(list.every(h => h.is_verified === 1))
  assert.equal(by('2026-03-20').name, "Eid'l Fitr"); assert.match(by('2026-03-20').source, /1189/)
  assert.equal(by('2026-05-27').name, "Eid'l Adha"); assert.match(by('2026-05-27').source, /1264/)
  assert.equal(by('2026-05-01').holiday_type, 'REGULAR'); assert.equal(by('2026-06-12').holiday_type, 'REGULAR')
  assert.equal(by('2026-02-25').holiday_type, 'SPECIAL_WORKING')
  for (const d of ['2026-02-17', '2026-11-02', '2026-12-24']) assert.equal(by(d).holiday_type, 'SPECIAL_NON_WORKING', d)
  assert.equal(by('2026-08-31').name, 'National Heroes Day')
  assert.equal(new Set(list.map(h => h.holiday_date)).size, list.length, 'no duplicate dates')
})
test('Proc. 1447: Nov 16-18 2026 are special non-working days (NCR) and block bookings', () => {
  const list = PH.baselineForYear(2026)
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-18']) { const h = list.find(x => x.holiday_date === d); assert.equal(h.holiday_type, 'SPECIAL_NON_WORKING', d); assert.match(h.source, /1447/); assert.match(h.name, /NCR/); assert.equal(PH.evaluateReservableDate(d, h).ok, false, d) }
})
test('2027 verified list (Proc. 1427): 10 regular incl. none guessed for Eid, 8 special non-working, 1 special working', () => {
  const list = PH.baselineForYear(2027), by = d => list.find(h => h.holiday_date === d)
  assert.deepEqual(PH.verifiedYears(), [2026, 2027])
  assert.equal(list.filter(h => h.holiday_type === 'REGULAR').length, 10)
  assert.equal(list.filter(h => h.holiday_type === 'SPECIAL_NON_WORKING').length, 8)
  assert.equal(list.filter(h => h.holiday_type === 'SPECIAL_WORKING').length, 1)
  assert.ok(list.every(h => h.is_verified === 1 && /1427/.test(h.source)))
  assert.ok(!list.some(h => /Eid/.test(h.name)), 'Eid dates are not proclaimed yet and must not be guessed')
  assert.equal(by('2027-02-25').holiday_type, 'SPECIAL_WORKING'); assert.equal(PH.evaluateReservableDate('2027-02-25', by('2027-02-25')).ok, true)
  assert.equal(by('2027-03-25').name, 'Maundy Thursday'); assert.equal(by('2027-08-30').name, 'National Heroes Day'); assert.equal(by('2027-12-24').holiday_type, 'SPECIAL_NON_WORKING')
  // weekday sanity (Asia/Manila calendar dates are plain strings, so these cannot drift with host timezone)
  assert.equal(new Date('2027-08-30T00:00:00Z').getUTCDay(), 1); assert.equal(new Date('2027-02-25T00:00:00Z').getUTCDay(), 4)
})
test('fixed-date defaults for other years are flagged unverified and never guess movable holidays', () => {
  const list = PH.baselineForYear(2028)
  assert.ok(list.length > 10 && list.every(h => h.is_verified === 0))
  assert.equal(PH.lastMondayOfAugust(2027), '2027-08-30'); assert.equal(PH.lastMondayOfAugust(2026), '2026-08-31')
  for (const movable of ["Eid'l Fitr", "Eid'l Adha", 'Good Friday', 'Maundy Thursday', 'Chinese New Year', 'Black Saturday']) assert.ok(!list.some(h => h.name === movable), movable)
  assert.deepEqual(PH.fixedDateDefaults(1999), [])
})
test('evaluateReservableDate: closed types block, special working stays open, Sunday rule, inactive rows ignored', () => {
  const reg = { name: 'X', holiday_type: 'REGULAR', is_active: 1 }
  assert.equal(PH.evaluateReservableDate('2026-12-25', reg).code, 'HOLIDAY')
  assert.equal(PH.evaluateReservableDate('2026-12-25', { ...reg, holiday_type: 'SPECIAL_NON_WORKING' }).ok, false)
  assert.equal(PH.evaluateReservableDate('2026-02-25', { ...reg, holiday_type: 'SPECIAL_WORKING' }).ok, true)
  assert.equal(PH.evaluateReservableDate('2026-12-25', { ...reg, is_active: 0 }).ok, true)
  assert.equal(PH.evaluateReservableDate('2026-11-01', null).code, 'SUNDAY')
  assert.equal(PH.evaluateReservableDate('2026-11-01', null, { blockSunday: false }).ok, true)
  assert.equal(PH.evaluateReservableDate('2026-02-30', null).code, 'INVALID_DATE')
  assert.equal(PH.evaluateReservableDate('2026-11-03', null).code, 'OPEN')
})
test('holiday input validation', () => {
  const ok = PH.validateHolidayInput({ holiday_date: '2027-01-05', name: '  Local   Suspension ', holiday_type: 'SPECIAL_NON_WORKING', source: ' Proc. X ' })
  assert.equal(ok.error, null); assert.equal(ok.values.name, 'Local Suspension'); assert.equal(ok.values.source, 'Proc. X')
  for (const bad of [{ holiday_date: '2027-13-01', name: 'a', holiday_type: 'REGULAR' }, { holiday_date: '2027-01-01', name: '', holiday_type: 'REGULAR' }, { holiday_date: '2027-01-01', name: 'a', holiday_type: 'NOPE' }, { holiday_date: '2027-01-01', name: 'x'.repeat(151), holiday_type: 'REGULAR' }, { holiday_date: '1990-01-01', name: 'a', holiday_type: 'REGULAR' }]) assert.ok(PH.validateHolidayInput(bad).error, JSON.stringify(bad))
})
test('Manila date helper does not depend on the host timezone', () => {
  assert.equal(PH.manilaDateString(new Date('2026-11-01T16:30:00Z')), '2026-11-02')
  assert.equal(PH.manilaDateString(new Date('2026-11-02T15:59:00Z')), '2026-11-02')
  assert.equal(PH.manilaDateString(new Date('2026-11-02T16:00:00Z')), '2026-11-03')
})

// ---- controller + routes ---------------------------------------------------------------------------------
function load(rows) {
  const queries = []
  const recycle = []
  const store = rows || []
  const pool = { query(sql, params, cb) {
    const n = sql.replace(/\s+/g, ' ').trim(); queries.push({ sql: n, params })
    const done = (err, res) => (typeof params === 'function' ? params : cb)(err, Array.isArray(res) ? res.map(r => ({ ...r })) : res)
    if (n.startsWith('INSERT IGNORE INTO holidays')) { const exists = store.some(r => r.holiday_date === params[0]); if (!exists) store.push({ id: store.length + 1, holiday_date: params[0], name: params[1], holiday_type: params[2], source: params[3], is_verified: params[4], is_active: 1 }); return done(null, { affectedRows: exists ? 0 : 1 }) }
    if (/FROM holidays WHERE holiday_date BETWEEN/.test(n)) return done(null, store.filter(r => r.holiday_date >= params[0] && r.holiday_date <= params[1]))
    if (/FROM holidays WHERE holiday_date = \?/.test(n)) return done(null, store.filter(r => r.holiday_date === params[0]).slice(0, 1))
    if (/FROM holidays WHERE id = \?/.test(n)) return done(null, store.filter(r => r.id === params[0]))
    if (n.startsWith('INSERT INTO recycle_bin')) { recycle.push(params); return done(null, { affectedRows: 1 }) }
    if (n.startsWith('INSERT INTO holidays')) { store.push({ id: store.length + 1, holiday_date: params[0], name: params[1], holiday_type: params[2], custom_type_label: params[3], source: params[4], is_verified: params[5], is_active: 1 }); return done(null, { affectedRows: 1 }) }
    if (n.startsWith('UPDATE holidays SET is_active = 0')) { const r = store.find(x => x.id === params[1]); r.is_active = 0; return done(null, { affectedRows: 1 }) }
    if (n.startsWith('UPDATE holidays SET holiday_date=?')) { const r = store.find(x => x.id === params[7]); Object.assign(r, { holiday_date: params[0], name: params[1], holiday_type: params[2], custom_type_label: params[3], is_active: 1 }); return done(null, { affectedRows: 1 }) }
    if (n.startsWith("SELECT id FROM holidays WHERE holiday_date = ? AND id <> ?")) return done(null, store.filter(r => r.holiday_date === params[0] && r.id !== params[1]))
    if (n.startsWith("SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date FROM holidays WHERE id = ?")) return done(null, store.filter(r => r.id === params[0]))
    if (n.startsWith('SELECT id, is_active FROM holidays WHERE holiday_date = ?')) return done(null, store.filter(r => r.holiday_date === params[0]))
    if (n.startsWith('UPDATE reservations SET holiday_flag = 1')) return done(null, { affectedRows: 2 })
    if (n.startsWith('UPDATE reservations SET holiday_flag = 0')) return done(null, { affectedRows: 1 })
    throw new Error(`Unexpected SQL: ${n}`)
  } }
  const audits = []
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), ctl = path.resolve(__dirname, '../controllers/holidayController.js')
  for (const [p, exp] of [[dbPath, pool], [auditPath, { logAudit: (...a) => audits.push(a) }]]) { const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  delete require.cache[ctl]
  return { controller: require(ctl), queries, store, audits, recycle }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const tick = () => new Promise(r => setTimeout(r, 5))

test('GET /holidays lazily seeds the verified baseline and returns names + blocking flags', async () => {
  const { controller, store } = load([]), r = res()
  await controller.listHolidays({ query: { year: '2026' } }, r); await tick()
  assert.equal(r.code, 200); assert.equal(r.body.timezone, 'Asia/Manila'); assert.equal(r.body.holidays.length, 24); assert.equal(store.length, 24)
  const fitr = r.body.holidays.find(h => h.holiday_date === '2026-03-20'); assert.equal(fitr.blocks_reservations, true); assert.equal(fitr.type_label, 'Regular Holiday')
  assert.equal(r.body.holidays.find(h => h.holiday_date === '2026-02-25').blocks_reservations, false)
})
test('lazy seeding flags existing reservations on newly closed dates, never on special working days, never deletes', async () => {
  const { controller, queries } = load([]); await controller.listHolidays({ query: { year: '2026' } }, res()); await tick()
  const flags = queries.filter(q => q.sql.startsWith('UPDATE reservations SET holiday_flag = 1'))
  assert.equal(flags.length, 23, '24 inserted minus the one special WORKING day')
  assert.ok(!flags.some(q => q.params[1] === '2026-02-25'))
  assert.ok(flags.some(q => q.params[1] === '2026-11-16'))
  assert.ok(!queries.some(q => /DELETE FROM reservations|SET status/i.test(q.sql)))
})
test('removed (soft-deleted) baseline holidays are not resurrected by re-seeding', async () => {
  const { controller, store } = load([{ id: 1, holiday_date: '2026-12-25', name: 'Christmas Day', holiday_type: 'REGULAR', is_active: 0 }])
  await controller.listHolidays({ query: { year: '2026' } }, res())
  assert.equal(store.find(r => r.holiday_date === '2026-12-25').is_active, 0); assert.equal(store.filter(r => r.holiday_date === '2026-12-25').length, 1)
})
test('creating a closed holiday flags existing reservations instead of deleting them', async () => {
  const { controller, queries, audits } = load([]), r = res()
  await controller.createHoliday({ body: { holiday_date: '2027-02-10', name: 'Typhoon Suspension', holiday_type: 'SPECIAL_NON_WORKING' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.flagged_reservations, 2); assert.match(r.body.message, /flagged for review \(not deleted\)/)
  assert.ok(queries.some(q => q.sql.startsWith('UPDATE reservations SET holiday_flag = 1')))
  assert.ok(!queries.some(q => /DELETE FROM reservations|SET status/i.test(q.sql)), 'never deletes or cancels reservations')
  assert.equal(audits[0][1], 'HOLIDAY ADDED')
})
test('a special WORKING day does not flag reservations', async () => {
  const { controller, queries } = load([]), r = res()
  await controller.createHoliday({ body: { holiday_date: '2027-02-10', name: 'Work Day', holiday_type: 'SPECIAL_WORKING' }, user: { id: 1 } }, r)
  assert.equal(r.code, 201); assert.equal(r.body.flagged_reservations, 0); assert.ok(!queries.some(q => q.sql.startsWith('UPDATE reservations SET holiday_flag = 1')))
})
test('duplicate active date is rejected; invalid input rejected; removal clears flags', async () => {
  const { controller } = load([{ id: 1, holiday_date: '2027-02-10', name: 'A', holiday_type: 'REGULAR', is_active: 1 }])
  let r = res(); await controller.createHoliday({ body: { holiday_date: '2027-02-10', name: 'B', holiday_type: 'REGULAR' }, user: { id: 1 } }, r); assert.equal(r.code, 409)
  r = res(); await controller.createHoliday({ body: { holiday_date: 'bad', name: 'B', holiday_type: 'REGULAR' }, user: { id: 1 } }, r); assert.equal(r.code, 400)
  r = res(); await controller.removeHoliday({ params: { id: '1' }, user: { id: 1 } }, r)
  assert.equal(r.code, 200); assert.equal(r.body.cleared_flags, 1)
  r = res(); await controller.removeHoliday({ params: { id: 'x' }, user: { id: 1 } }, r); assert.equal(r.code, 400)
})
test('moving a holiday to another date flags the new date and clears the old one', async () => {
  const { controller } = load([{ id: 1, holiday_date: '2027-02-10', name: 'A', holiday_type: 'REGULAR', is_active: 1 }]), r = res()
  await controller.updateHoliday({ params: { id: '1' }, body: { holiday_date: '2027-02-11', name: 'A', holiday_type: 'REGULAR' }, user: { id: 1 } }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.flagged_reservations, 2); assert.equal(r.body.cleared_flags, 1)
})
test('holiday routes: everyone signed in may read; only MIS (Super Admin) may change', () => {
  const order = []
  const rp = path.resolve(__dirname, '../middleware/roleAuth.js'); const m = new Module(rp); m.filename = rp; m.loaded = true
  m.exports = { requireRole: (...roles) => { order.push(roles); return (q, s, n) => n() } }; require.cache[rp] = m
  const routes = path.resolve(__dirname, '../routes/holidayRoutes.js'); delete require.cache[routes]
  const router = require(routes), out = {}
  router.stack.filter(l => l.route).forEach((layer, i) => { out[`${Object.keys(layer.route.methods)[0]} ${layer.route.path}`] = order[i] })
  delete require.cache[rp]
  assert.deepEqual(out['get /'], ['MIS', 'Dean', 'Teacher', 'Inventory Staff', 'Others']) // CP68: custom roles may read holidays when reserving
  for (const key of ['post /', 'put /:id', 'delete /:id', 'post /generate-defaults']) assert.deepEqual(out[key], ['MIS'], key)
})

test('Others: custom holiday type requires a label, is stored, blocks reservations and shows its own label', async () => {
  assert.match(PH.validateHolidayInput({ holiday_date: '2027-02-10', name: 'Founding Day', holiday_type: 'OTHER' }).error, /holiday type/i)
  assert.equal(PH.validateHolidayInput({ holiday_date: '2027-02-10', name: 'Founding Day', holiday_type: 'OTHER', custom_type_label: ' Local   Event ' }).values.custom_type_label, 'Local Event')
  assert.equal(PH.validateHolidayInput({ holiday_date: '2027-02-10', name: 'X', holiday_type: 'REGULAR', custom_type_label: 'ignored' }).values.custom_type_label, null)
  const { controller, store } = load([]), r = res()
  await controller.createHoliday({ body: { holiday_date: '2027-02-10', name: 'Founding Day', holiday_type: 'OTHER', custom_type_label: 'Local Event' }, user: { id: 1 } }, r)
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(store[0].custom_type_label, 'Local Event')
  assert.equal(r.body.holiday.type_label, 'Local Event'); assert.equal(r.body.holiday.blocks_reservations, true)
})
test('removing a holiday soft-deletes it AND writes a Recycle Bin entry (restore happens in the Recycle Bin)', async () => {
  const { controller, recycle, store } = load([{ id: 1, holiday_date: '2027-02-10', name: 'A', holiday_type: 'REGULAR', is_active: 1 }]), r = res()
  await controller.removeHoliday({ params: { id: '1' }, user: { id: 9 } }, r)
  assert.equal(r.code, 200); assert.equal(store[0].is_active, 0); assert.equal(recycle.length, 1); assert.equal(recycle[0][0], 'holidays'); assert.equal(recycle[0][1], 1)
  const again = res(); await controller.removeHoliday({ params: { id: '1' }, user: { id: 9 } }, again); assert.equal(again.code, 409); assert.equal(recycle.length, 1)
})
