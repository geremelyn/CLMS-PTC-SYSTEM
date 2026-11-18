const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })

const reservationRow = (id, extra = {}) => ({ id, laboratory_id: 2, reserved_by: 7, reservation_date: new Date('2026-11-09T16:00:00.000Z'), start_time: '09:00:00', end_time: '10:00:00', status: 'CANCELLED', purpose: 'Lecture', created_at: new Date('2026-11-01T02:00:00.000Z'), ...extra })

function load({ existing = [reservationRow(1), reservationRow(2)], binRows = {}, labExists = true, userExists = true, clash = false, failDelete = false, holidayRows = [] } = {}) {
  const calls = [], bin = { ...binRows }, inserted = []
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() { calls.push('RELEASE') },
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push(n)
      if (n.startsWith('SELECT * FROM reservations WHERE id IN')) return cb(null, existing.filter(r => values.includes(r.id)))
      if (n.startsWith('INSERT INTO recycle_bin')) { inserted.push(...values[0]); return cb(null, { affectedRows: values[0].length }) }
      if (n.startsWith('DELETE FROM reservations')) return cb(null, { affectedRows: failDelete ? 0 : values.length })
      if (n.startsWith("SELECT id FROM recycle_bin WHERE entity_type = 'reservations'")) return cb(null, values.map((v, i) => ({ id: 100 + i })))
      if (n.startsWith("SELECT id, snapshot_json FROM recycle_bin WHERE entity_type = 'computers'")) return cb(null, [])   // CP181 pre-lock query: no computers in these reservation tests
      if (n.startsWith('SELECT * FROM recycle_bin WHERE id = ?')) return cb(null, bin[values[0]] ? [bin[values[0]]] : [])
      if (n.startsWith('SELECT id FROM reservations WHERE id = ?')) return cb(null, [])
      if (n.startsWith('SELECT id FROM laboratories')) return cb(null, labExists ? [{ id: 2 }] : [])
      if (n.startsWith('SELECT id FROM users')) return cb(null, userExists ? [{ id: 7 }] : [])
      if (n.startsWith('SELECT id, start_time, end_time FROM reservations WHERE laboratory_id')) return cb(null, clash ? [{ id: 999 }] : [])
      if (n.startsWith('INSERT INTO reservations')) { calls.push({ restoreInsert: { fields: n, values } }); return cb(null, { affectedRows: 1 }) }
      if (n.includes('FROM holidays')) return cb(null, holidayRows)
      if (n.startsWith('UPDATE reservations SET holiday_flag = 1')) { calls.push({ flagged: { values } }); return cb(null, { affectedRows: 1 }) }
      if (n.startsWith('UPDATE recycle_bin SET restored_at')) return cb(null, { affectedRows: 1 })
      cb(new Error('Unexpected SQL: ' + n))
    }
  }
  stub('../database/db.js', { getConnection: cb => cb(null, connection), query: (s, v, cb) => cb(null, []) })
  stub('../utils/auditLogger.js', { logAudit() {} })
  for (const f of ['bulkRecordController', 'recycleBinController']) delete require.cache[path.resolve(__dirname, `../controllers/${f}.js`)]
  return { controller: require('../controllers/recycleBinController.js'), calls, inserted }
}
const mis = { id: 1, role: 'MIS' }

test('deleting reservations moves them to the Recycle Bin in one transaction, with NO 10-minute undo record', async () => {
  const { controller, calls, inserted } = load(), r = res()
  await controller.deleteReservations({ body: { ids: [1, 2] }, user: mis }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.match(r.body.message, /^Successfully deleted 2 reservations/)
  assert.equal(r.body.deletedCount, 2); assert.deepEqual(r.body.recycleIds, [100, 101])
  assert.equal(inserted.length, 2); assert.equal(inserted[0][0], 'reservations')
  const sqls = calls.filter(c => typeof c === 'string')
  assert.ok(!sqls.some(q => q.includes('undo_actions')), 'must not create an expiring undo record')
  assert.ok(sqls.indexOf(sqls.find(q => q.startsWith('INSERT INTO recycle_bin'))) < sqls.indexOf(sqls.find(q => q.startsWith('DELETE FROM reservations'))), 'snapshot is saved before the delete')
  assert.ok(calls.includes('COMMIT') && !calls.includes('ROLLBACK'))
  const snap = JSON.parse(inserted[0][3]); assert.equal(snap.reservation_date, '2026-11-10 00:00:00'); assert.equal(snap.created_at, '2026-11-01 10:00:00')
})
test('a reservation deleted by someone else meanwhile is skipped AND reported; the rest are deleted (Selected and All behave the same)', async () => {
  for (const skipMissing of [undefined, true]) {
    const { controller, calls } = load({ existing: [reservationRow(1)] }), r = res()
    await controller.deleteReservations({ body: { ids: [1, 2], skipMissing }, user: mis }, r)
    assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skippedCount, 1); assert.equal(r.body.skipped[0].id, 2)
    assert.match(r.body.message, /1 could not be deleted/); assert.ok(calls.includes('COMMIT'))
  }
})
test('when NONE of the reservations exist any more the request fails with 409 and nothing is removed', async () => {
  const { controller, calls } = load({ existing: [] }), r = res()
  await controller.deleteReservations({ body: { ids: [1, 2] }, user: mis }, r)
  assert.equal(r.code, 409); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(c => typeof c === 'string' && c.startsWith('DELETE FROM')))
})
test('delete validates input and rolls back on a count mismatch', async () => {
  for (const ids of [[], 'x', [0], [1.5], Array.from({ length: 5001 }, (_, i) => i + 1)]) { const { controller } = load(), r = res(); await controller.deleteReservations({ body: { ids }, user: mis }, r); assert.equal(r.code, 400, JSON.stringify(ids).slice(0, 20)) }
  const { controller, calls } = load({ failDelete: true }), r = res()
  await controller.deleteReservations({ body: { ids: [1] }, user: mis }, r)
  assert.equal(r.code, 500); assert.ok(calls.includes('ROLLBACK'))
})
test('restore returns reservations exactly as deleted, with no time limit, and marks the bin rows restored', async () => {
  const snap = JSON.stringify({ id: 1, laboratory_id: 2, reserved_by: 7, reservation_date: '2026-11-10 00:00:00', start_time: '09:00:00', end_time: '10:00:00', status: 'APPROVED', purpose: 'Lecture' })
  const old = { id: 100, entity_type: 'reservations', entity_id: 1, label: 'Reservation #1', snapshot_json: snap, restored_at: null, deleted_at: '2020-01-01 00:00:00' }
  const { controller, calls } = load({ binRows: { 100: old } }), r = res()
  await controller.restoreRecycleItems({ body: { ids: [100] }, user: mis }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.restoredCount, 1)
  const ins = calls.find(c => c.restoreInsert).restoreInsert
  assert.equal(ins.values[ins.values.length - 1] !== undefined, true); assert.ok(ins.values.includes('2026-11-10 00:00:00'))
  assert.ok(calls.includes('COMMIT'))
})
test('batch restore is all-or-nothing: one blocked reservation rolls back every restore', async () => {
  const mk = (id, status) => ({ id: 100 + id, entity_type: 'reservations', entity_id: id, label: `Reservation #${id}`, restored_at: null, snapshot_json: JSON.stringify({ id, laboratory_id: 2, reserved_by: 7, reservation_date: '2026-11-10 00:00:00', start_time: '09:00:00', end_time: '10:00:00', status }) })
  const { controller, calls } = load({ binRows: { 101: mk(1, 'APPROVED'), 102: mk(2, 'COMPLETED') }, clash: true }), r = res()
  await controller.restoreRecycleItems({ body: { ids: [101, 102] }, user: mis }, r)
  assert.equal(r.code, 409); assert.match(r.body.message, /Nothing was restored/); assert.match(r.body.message, /Reservation #1/)
  assert.ok(calls.includes('ROLLBACK') && !calls.includes('COMMIT'))
})
test('restore is refused when the laboratory or reserving user no longer exists', async () => {
  const item = { id: 100, entity_type: 'reservations', entity_id: 1, label: 'Reservation #1', restored_at: null, snapshot_json: JSON.stringify({ id: 1, laboratory_id: 2, reserved_by: 7, reservation_date: '2026-11-10 00:00:00', start_time: '09:00:00', end_time: '10:00:00', status: 'PENDING' }) }
  for (const opts of [{ labExists: false }, { userExists: false }]) { const { controller } = load({ binRows: { 100: item }, ...opts }), r = res(); await controller.restoreRecycleItems({ body: { ids: [100] }, user: mis }, r); assert.equal(r.code, 409, JSON.stringify(opts)) }
})
test('reservation delete route is MIS-only and no reservation undo-bulk-delete route remains', () => {
  const seen = []
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => { seen.push(roles); return (q, s, n) => n() } })
  const rp = path.resolve(__dirname, '../routes/reservationRoutes.js'); delete require.cache[rp]
  const router = require(rp)
  const paths = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
  assert.ok(paths.includes('POST /bulk-delete')); assert.ok(!paths.some(p => p.includes('undo-bulk-delete')))
  const del = router.stack.find(l => l.route?.path === '/bulk-delete'); assert.equal(del.route.stack.length, 2)
  assert.deepEqual(seen.find(r => r.length === 1 && r[0] === 'MIS'), ['MIS'])
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
})

test('restoring a reservation whose date is now a holiday keeps it (never lost) but flags it for review; open dates are not flagged', async () => {
  const mk = (date, status = 'APPROVED') => ({ id: 100, entity_type: 'reservations', entity_id: 5, label: 'Reservation #5', restored_at: null, snapshot_json: JSON.stringify({ id: 5, laboratory_id: 2, reserved_by: 7, reservation_date: `${date} 00:00:00`, start_time: '09:00:00', end_time: '10:00:00', status }) })
  const closed = load({ binRows: { 100: mk('2026-11-17') } }), r1 = res()   // 2026-11-17 = Proc. 1447 NCR special non-working day (baseline)
  await closed.controller.restoreRecycleItem({ params: { id: '100' }, user: mis }, r1)
  assert.equal(r1.code, 200, JSON.stringify(r1.body)); assert.equal(r1.body.holidayFlagged, true); assert.match(r1.body.message, /ASEAN Summit/)
  assert.ok(closed.calls.some(c => c.restoreInsert), 'row is restored'); assert.ok(closed.calls.some(c => c.flagged), 'row is flagged')
  const open = load({ binRows: { 100: mk('2026-11-19') } }), r2 = res()
  await open.controller.restoreRecycleItem({ params: { id: '100' }, user: mis }, r2)
  assert.equal(r2.code, 200); assert.ok(!open.calls.some(c => c.flagged)); assert.equal(r2.body.holidayFlagged, false)
  const done = load({ binRows: { 100: mk('2026-11-17', 'CANCELLED') } }), r3 = res()
  await done.controller.restoreRecycleItem({ params: { id: '100' }, user: mis }, r3)
  assert.ok(!done.calls.some(c => c.flagged), 'cancelled/declined records are not flagged')
})
