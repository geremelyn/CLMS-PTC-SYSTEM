const test = require('node:test')
const assert = require('node:assert/strict')

test('reservation list sorts newest creation first and leaves older reservations on later pages', async () => {
  const { sortReservationsNewestFirst } = await import('../../client/src/utils/reservationSorting.mjs')
  const rows = [
    { id: 3, created_at: '2026-01-01T10:00:00+08:00', purpose: 'older' },
    { id: 4, created_at: '2026-01-02T10:00:00+08:00', purpose: 'newest' },
    { id: 5, created_at: '2026-01-02T10:00:00+08:00', purpose: 'same time higher id' }
  ]
  const sorted = sortReservationsNewestFirst(rows)
  assert.deepEqual(sorted.map(row => row.id), [5, 4, 3])
  const pageSize = 2
  assert.deepEqual(sorted.slice(0, pageSize).map(row => row.purpose), ['same time higher id', 'newest'])
  assert.deepEqual(sorted.slice(pageSize).map(row => row.purpose), ['older'])
  assert.deepEqual(rows.map(row => row.id), [3, 4, 5], 'sort must not mutate the source array')
})
test('reservation sorting falls back to reservation date/time when creation timestamp is missing', async () => {
  const { sortReservationsNewestFirst } = await import('../../client/src/utils/reservationSorting.mjs')
  const sorted = sortReservationsNewestFirst([{ id: 1, reservation_date: '2026-01-01', start_time: '09:00' }, { id: 2, reservation_date: '2026-01-02', start_time: '09:00' }])
  assert.deepEqual(sorted.map(row => row.id), [2, 1])
})
