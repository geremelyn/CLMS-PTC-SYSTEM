'use strict'
// CP65: Date Requested column. Pure-function + static source checks + mocked-db check of the list query. No real MySQL, no browser.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const client = path.join(__dirname, '..', '..', 'client', 'src')
const read = (...p) => fs.readFileSync(path.join(client, ...p), 'utf8')

test('formatDateRequested shows the creation timestamp in Asia/Manila, not the reservation date', async () => {
  const { formatDateRequested } = await import(path.join(client, 'utils', 'reservationTime.js'))
  assert.match(formatDateRequested('2026-11-08T07:47:00.000Z'), /Nov 8, 2026.*3:47\s*PM/i)   // 07:47Z = 15:47 Manila
  assert.match(formatDateRequested('2026-11-08 15:47:00'), /Nov 8, 2026.*3:47\s*PM/i)          // zone-less = server +08:00 wall time
  assert.match(formatDateRequested('2026-11-08T23:30:00.000Z'), /Nov 9, 2026.*7:30\s*AM/i)     // crosses midnight in Manila
  for (const bad of [null, undefined, '', 'garbage']) assert.equal(formatDateRequested(bad), '—')
})
test('every reservation table adds a Date Requested column fed by created_at, existing columns kept', () => {
  const res = read('pages', 'Reservations.jsx'), mine = read('pages', 'MyReservations.jsx'), appr = read('pages', 'ApprovedClasses.jsx')
  assert.equal((res.match(/formatDateRequested\(\w+\.created_at\)/g) || []).length, 2)
  assert.match(res, /<th>DATE REQUESTED<\/th>/); assert.match(res, /<th>Date Requested<\/th>/)
  assert.match(mine, /<th>Date Requested<\/th>/); assert.match(mine, /formatDateRequested\(reservation\.created_at\)/)
  assert.match(appr, /<th>Date Requested<\/th>/); assert.match(appr, /formatDateRequested\(reservation\.created_at\)/)
  for (const [src, header] of [[res, 'RESERVATION DATE &amp; TIME'], [res, 'Reservation Date &amp; Time'], [mine, 'Reservation Date &amp; Time']]) assert.ok(src.includes(header))
  assert.match(mine, /colSpan="6"/); assert.doesNotMatch(mine, /colSpan="5"/)
})
test('list API selects reservations.* (includes created_at) for MIS, Dean, Teacher and Inventory Staff; no new column', () => {
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'reservationController.js'), 'utf8')
  assert.match(ctl, /SELECT\s+reservations\.\*,/)
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'database', 'ensureSchema.js'), 'utf8'), /date_requested/i)
})
