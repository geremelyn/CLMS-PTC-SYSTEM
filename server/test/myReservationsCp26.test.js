// CP26 - Dean/Teacher My Reservations: sorting, failed submissions, statuses.
// Tests the pure helpers the page uses (client/src/utils/reservationSorting.mjs) plus source-level wiring checks on the page.
// NOT tested: rendering in a browser (no DOM/browser harness run here).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const load = () => import('../../client/src/utils/reservationSorting.mjs')
const row = (id, status, created, extra = {}) => ({ id, status, created_at: created, reserved_by: 7, reservation_date: '2026-12-01', start_time: '09:00:00', ...extra })

test('sorting: newest submission first and COMPLETED reservations at the bottom', async () => {
  const { sortMyReservations } = await load()
  const rows = [
    row(1, 'COMPLETED', '2026-11-06T10:00:00+08:00'), // newest, but completed
    row(2, 'PENDING', '2026-11-01T10:00:00+08:00'),
    row(3, 'APPROVED', '2026-11-05T10:00:00+08:00'),
    row(4, 'COMPLETED', '2026-10-01T10:00:00+08:00'),
    row(5, 'CANCELLED', '2026-11-04T10:00:00+08:00'),
    row(6, 'DECLINED', '2026-11-03T10:00:00+08:00')
  ]
  assert.deepEqual(sortMyReservations(rows).map(r => r.id), [3, 5, 6, 2, 1, 4])
  assert.deepEqual(rows.map(r => r.id), [1, 2, 3, 4, 5, 6], 'does not mutate the source array')
})

test('sorting: ties fall back to higher id; missing created_at falls back to reservation date', async () => {
  const { sortMyReservations } = await load()
  const same = '2026-11-05T10:00:00+08:00'
  assert.deepEqual(sortMyReservations([row(1, 'PENDING', same), row(2, 'PENDING', same)]).map(r => r.id), [2, 1])
  const noCreated = [{ id: 1, status: 'PENDING', reservation_date: '2026-01-01', start_time: '09:00' }, { id: 2, status: 'PENDING', reservation_date: '2026-01-02', start_time: '09:00' }]
  assert.deepEqual(sortMyReservations(noCreated).map(r => r.id), [2, 1])
})

test('sorting happens before paging: page 1 holds the newest non-completed rows and completed rows land on the last page', async () => {
  const { sortMyReservations } = await load()
  const rows = []
  for (let i = 1; i <= 25; i++) rows.push(row(i, i % 5 === 0 ? 'COMPLETED' : 'PENDING', `2026-11-${String(i).padStart(2, '0')}T10:00:00+08:00`))
  const sorted = sortMyReservations(rows), pageSize = 10
  const page1 = sorted.slice(0, pageSize)
  assert.ok(page1.every(r => r.status !== 'COMPLETED'))
  assert.equal(page1[0].id, 24)
  assert.ok(sorted.slice(-5).every(r => r.status === 'COMPLETED'))
})

test('failed submissions (system-declined at creation) are hidden; real declines and other statuses stay', async () => {
  const { visibleOwnReservations, isFailedSubmission } = await load()
  const cutoff = row(1, 'DECLINED', '2026-11-05T10:00:00+08:00', { decision_note: 'Reservation requests must be submitted more than 3 days before the scheduled date.' })
  const overlap = row(2, 'DECLINED', '2026-11-05T10:00:00+08:00', { decision_note: 'The requested time overlaps an existing reservation.' })
  const session = row(3, 'DECLINED', '2026-11-05T10:00:00+08:00', { decision_note: 'The Morning session already has a reservation.' })
  const misDeclined = row(4, 'DECLINED', '2026-11-05T10:00:00+08:00', { decision_note: 'Lab under repair', decided_by: 1, decided_at: '2026-11-06 09:00:00' })
  const sweepDeclined = row(5, 'DECLINED', '2026-11-05T10:00:00+08:00', { decision_note: 'Not approved before the 3-day scheduling cutoff', decided_at: '2026-11-06 09:00:00' })
  const others = [row(6, 'PENDING', '2026-11-05T10:00:00+08:00'), row(7, 'APPROVED', '2026-11-05T10:00:00+08:00', { decided_by: 1, decided_at: '2026-11-06 09:00:00' }), row(8, 'COMPLETED', '2026-11-05T10:00:00+08:00'), row(9, 'CANCELLED', '2026-11-05T10:00:00+08:00', { cancellation_note: 'Automatically cancelled: no MIS decision within 3 days of submission.', cancelled_at: '2026-11-08 10:00:00' })]
  assert.ok([cutoff, overlap, session].every(isFailedSubmission))
  assert.ok(![misDeclined, sweepDeclined, ...others].some(isFailedSubmission))
  assert.deepEqual(visibleOwnReservations([cutoff, overlap, session, misDeclined, sweepDeclined, ...others]).map(r => r.id), [4, 5, 6, 7, 8, 9])
})

test('Undo creation is offered only for a genuinely pending, unprocessed request', async () => {
  const { canUndoReservationCreation } = await load()
  const failed = row(1, 'DECLINED', '2026-11-05 10:00:00', { decision_note: 'Reservation requests must be submitted more than 3 days before the scheduled date.' })
  assert.equal(canUndoReservationCreation(failed), false)
  assert.equal(canUndoReservationCreation(row(2, 'DECLINED', '2026-11-05 10:00:00')), false)
  assert.equal(canUndoReservationCreation(row(3, 'PENDING', '2026-11-05 10:00:00')), true)
  assert.equal(canUndoReservationCreation(row(4, 'PENDING', '2026-11-05 10:00:00', { decided_at: '2026-11-06 09:00:00' })), false)
  for (const s of ['APPROVED', 'CANCELLED', 'COMPLETED']) assert.equal(canUndoReservationCreation(row(5, s, '2026-11-05 10:00:00')), false, s)
})

test('statuses: automatically CANCELLED is recognised and kept visible with its note; manual cancellation is not mislabeled', async () => {
  const { isAutoCancelled, visibleOwnReservations } = await load()
  const auto = row(1, 'CANCELLED', '2026-11-01T10:00:00+08:00', { cancellation_note: 'Automatically cancelled: no MIS decision within 3 days of submission.', cancelled_at: '2026-11-04 10:00:00' })
  const manual = row(2, 'CANCELLED', '2026-11-01T10:00:00+08:00', { cancellation_note: 'Class suspended', cancelled_at: '2026-11-04 10:00:00', cancelled_by: 7 })
  assert.equal(isAutoCancelled(auto), true); assert.equal(isAutoCancelled(manual), false)
  assert.equal(visibleOwnReservations([auto, manual]).length, 2)
})

test('page wiring: uses the shared helpers, keeps search/pagination/cancel, and no longer sorts by reservation date or offers undo for DECLINED', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/MyReservations.jsx'), 'utf8')
  assert.match(src, /visibleOwnReservations\(/); assert.match(src, /sortMyReservations\(filteredReservations\)/); assert.match(src, /sortedReservations\.slice\(/)
  assert.match(src, /canUndoReservationCreation/); assert.doesNotMatch(src, /\['PENDING', 'DECLINED'\]\.includes/)
  assert.match(src, /searchTerm/); assert.match(src, /pageSize/); assert.match(src, /submitCancellation/); assert.match(src, /reservation\.status === 'APPROVED' &&/)
  assert.match(src, /reservation\.status === 'CANCELLED' && reservation\.cancellation_note/)
})
