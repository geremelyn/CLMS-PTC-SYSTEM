'use strict'
// CP84 focused checks. OFFLINE only: mocked db, pure functions, static source/CSS checks. Nothing here ran against a live MySQL/MariaDB or a real browser.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const root = path.join(__dirname, '..', '..'), client = path.join(root, 'client', 'src')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')

test('submission: no creation-time rejection for tomorrow / within 3 days; new requests are PENDING; CP106: no automatic expiry', () => {
  const ctl = read('server', 'controllers', 'reservationController.js')
  assert.doesNotMatch(ctl, /approvalCutoffDays|CUTOFF_DAYS/) // (the 'must be submitted more than' text only filters OLD already-declined rows out of the MIS Staff view)
  assert.match(ctl, /'PENDING'/)
  // CP106: the CP81 automatic expiry (EXPIRE_SQL / PENDING_EXPIRY_DAYS) was removed; new requests simply stay PENDING (see reservationNoAutoExpiryCp106.test.js).
  assert.equal(Object.keys(require('../utils/pendingReservationExpiry.js')).includes('EXPIRE_SQL'), false)
})
test('Delete All "no valid id" root cause: a reservation row with id 0 is repaired to the next free id (mocked db); no-op otherwise', async () => {
  const calls = []
  let zeroRows = 1
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  stub('../database/db.js', { query(sql, params, cb) { const n = sql.replace(/\s+/g, ' '); calls.push({ n, params }); if (/SHOW TABLES/.test(n)) return cb(null, [{ t: 1 }]); if (/WHERE id = 0/.test(n) && /COUNT/.test(n)) return cb(null, [{ n: zeroRows }]); if (/MAX\(id\)/.test(n)) return cb(null, [{ next_id: 42 }]); cb(null, { affectedRows: 1 }) } })
  const p = path.resolve(__dirname, '../database/ensureSchema.js'); delete require.cache[p]
  const { repairZeroIdRows } = require(p)
  assert.equal(await repairZeroIdRows('reservations'), 1)
  const update = calls.find(c => /^UPDATE `reservations` SET id = \? WHERE id = 0 LIMIT 1/.test(c.n)); assert.ok(update); assert.deepEqual(update.params, [42])
  assert.ok(!calls.some(c => /DELETE|DROP|TRUNCATE/i.test(c.n)))
  calls.length = 0; zeroRows = 0
  assert.equal(await repairZeroIdRows('reservations'), 0); assert.ok(!calls.some(c => /^UPDATE/.test(c.n)))
})
test('Delete All protections unchanged: client sends only finished rows, server rejects Pending/Approved for Delete All', () => {
  assert.match(read('client', 'src', 'pages', 'Reservations.jsx'), /DELETABLE_STATUSES = \['COMPLETED', 'DECLINED', 'CANCELLED'\]/)
  assert.match(read('server', 'controllers', 'recycleBinController.js'), /isEligible = record => !deleteAll \|\| DELETABLE_RESERVATION_STATUSES/)
})
test('Notes column: header "Notes", shows cancellation note or decline reason, and wraps inside a bounded width', () => {
  const jsx = read('client', 'src', 'pages', 'Reservations.jsx'), css = read('client', 'src', 'pages', 'Reservations.css')
  assert.match(jsx, /<th className="reservation-note-cell">Notes<\/th>/); assert.match(jsx, /item\.cancellation_note \|\| item\.decision_note \|\| '—'/)
  assert.match(css, /td\.reservation-note-cell\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;[^}]*max-width: 320px/)
})
test('Maintenance bulk bar sizing also applies outside the Super Admin shell (MIS Staff)', () => {
  const css = read('client', 'src', 'pages', 'Maintenance.css')
  assert.match(css, /\n\.maintenance-bulk-bar \.maintenance-update-button,\n\.maintenance-bulk-bar \.clms-delete-all \{[^}]*min-height: 36px/)
  assert.match(css, /\.clms-app-shell \.maintenance-bulk-bar \.maintenance-update-button/)
})
test('greeting is "Welcome, [User Name]!" on every dashboard', async () => {
  const { welcomeGreeting } = await import(path.join(client, 'utils', 'roleDisplay.js'))
  assert.equal(welcomeGreeting({ role: 'Dean', full_name: 'Maria Santos' }), 'Welcome, Maria Santos!')
  assert.equal(welcomeGreeting({ role: 'Teacher', full_name: 'Juan P. Cruz' }), 'Welcome, Juan P. Cruz!')
  assert.equal(welcomeGreeting({ role: 'Inventory Staff', full_name: 'Ana Reyes' }), 'Welcome, Ana Reyes!')
  assert.equal(welcomeGreeting({ role: 'Others', role_other: 'Laboratory Assistant', full_name: 'Lia Tan' }), 'Welcome, Lia Tan!')
  assert.equal(welcomeGreeting({ role: 'MIS', full_name: 'whoever' }), 'Welcome, Super Admin!')
  assert.equal(welcomeGreeting({ role: 'Inventory Staff', full_name: '' }), 'Welcome, MIS Staff!')
  for (const f of ['MISDashboard', 'InventoryDashboard', 'DeanDashboard', 'TeacherDashboard']) { const s = read('client', 'src', 'pages', `${f}.jsx`); assert.match(s, /<h1>\{welcomeGreeting\(user\)\}<\/h1>/, f); assert.doesNotMatch(s, /<h1>Welcome /, f) }
})
