'use strict'
// CP53 regression tests: Super Admin Reservations Delete All / Delete Selected.
// SQLITE (real controller SQL on SQLite, NOT MySQL/MariaDB) + MOCKED route/role stubs + source-level frontend contract.
// Real Express/HTTP, a browser and a real MySQL/MariaDB database were NOT used.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createSqliteDb, loadControllers, res, count } = require('./helpers/sqliteMysqlAdapter.js')
const MIS = { id: 1, role: 'MIS' }
const STATUSES = ['PENDING', 'APPROVED', 'COMPLETED', 'DECLINED', 'CANCELLED'] // ids 1..5

function seed(extra = 0) {
  const db = createSqliteDb(), s = db.sqlite
  s.prepare("INSERT INTO users (id, username, full_name, role) VALUES (1,'mis','Super Admin','MIS'),(7,'t7','Teacher Seven','Teacher')").run()
  s.prepare("INSERT INTO laboratories (id, laboratory_name, capacity, status) VALUES (2,'Lab 2',40,'OPEN')").run()
  const insert = s.prepare('INSERT INTO reservations (id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, subject_name) VALUES (?,?,?,?,?,?,?,?)')
  STATUSES.forEach((status, index) => insert.run(index + 1, 2, 7, '2026-11-10', '08:00:00', '09:00:00', status, `Subject ${index + 1}`))
  for (let i = 0; i < extra; i++) insert.run(100 + i, 2, 7, '2026-11-11', '08:00:00', '09:00:00', 'COMPLETED', `Extra ${i}`)
  return db
}
const remaining = db => db.sqlite.prepare('SELECT id, status FROM reservations ORDER BY id').all()
async function del(db, body, user = MIS) { const { bin } = loadControllers(db); const r = res(); await bin.deleteReservations({ body, user }, r); return r }

test('valid ids: Completed, Declined and Cancelled go to the Recycle Bin with snapshots; Pending and Approved stay untouched', async () => {
  const db = seed(), r = await del(db, { ids: [1, 2, 3, 4, 5], skipMissing: true, deleteAll: true })
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 3); assert.equal(r.body.skippedCount, 2)
  assert.deepEqual(remaining(db).map(x => x.status), ['PENDING', 'APPROVED'])
  assert.equal(count(db, 'recycle_bin', "entity_type='reservations' AND restored_at IS NULL"), 3); assert.equal(r.body.recycleIds.length, 3)
  assert.match(r.body.message, /Successfully deleted 3 reservations\./); assert.match(r.body.message, /2 Pending\/Approved reservations were left untouched/)
  assert.deepEqual(r.body.skipped.map(x => x.id).sort(), [1, 2]); assert.ok(r.body.skipped.every(x => /cannot be deleted/.test(x.reason)))
})
test('Delete All with a mixed set (Pending + Approved + one eligible): only the eligible one is deleted', async () => {
  const db = seed(), r = await del(db, { ids: [1, 2, 4], deleteAll: true })
  assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1); assert.equal(count(db, 'reservations'), 4); assert.equal(count(db, 'reservations', 'id = 4'), 0)
})
test('Delete All containing only Pending/Approved: 409, nothing deleted, nothing in the Recycle Bin', async () => {
  const db = seed(), r = await del(db, { ids: [1, 2], deleteAll: true })
  assert.equal(r.code, 409); assert.match(r.body.message, /only Completed, Declined and Cancelled/); assert.equal(count(db, 'reservations'), 5); assert.equal(count(db, 'recycle_bin'), 0)
})
test('empty selection is refused clearly', async () => {
  const db = seed()
  for (const body of [{ ids: [] }, {}, { ids: 'x' }]) { const r = await del(db, body); assert.equal(r.code, 400); assert.match(r.body.message, /No reservations were selected/) }
  assert.equal(count(db, 'reservations'), 5)
})
test('missing / invalid ids are rejected, the message names the offending values, and nothing is deleted', async () => {
  const db = seed()
  for (const ids of [[3, null], [3, undefined], [3, 'abc'], [3, 0], [3, -1], [3, 1.5], [3, {}], [3, '']]) {
    const r = await del(db, { ids }); assert.equal(r.code, 400, JSON.stringify(ids)); assert.match(r.body.message, /invalid reservation id \(1 of 2: /); assert.match(r.body.message, /Nothing was deleted/); assert.ok(Array.isArray(r.body.invalidIds))
  }
  assert.equal(count(db, 'reservations'), 5); assert.equal(count(db, 'recycle_bin'), 0)
})
test('numeric-string ids and duplicates from the page are accepted', async () => {
  const db = seed(), r = await del(db, { ids: ['3', 3, ' 4 '] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 2)
})
test('an id that no longer exists is skipped and reported, the rest is deleted', async () => {
  const db = seed(), r = await del(db, { ids: [3, 999], skipMissing: true }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skipped[0].id, 999); assert.match(r.body.message, /already deleted by someone else/)
})
test('Delete All of 1,205 reservations: only the finished ones go, the 2 active ones remain, and the Recycle Bin restores everything', async () => {
  const db = seed(1200), { bin } = loadControllers(db), all = db.sqlite.prepare('SELECT id FROM reservations ORDER BY id').all().map(x => x.id)
  const r = await del(db, { ids: all, skipMissing: true, deleteAll: true }); assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 200))
  assert.equal(r.body.deletedCount, 1203); assert.equal(count(db, 'reservations'), 2); assert.deepEqual(remaining(db).map(x => x.status), ['PENDING', 'APPROVED'])
  for (let i = 0; i < r.body.recycleIds.length; i += 1000) { const rr = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds.slice(i, i + 1000) }, user: MIS }, rr); assert.equal(rr.code, 200, JSON.stringify(rr.body)) }
  assert.equal(count(db, 'reservations'), 1205); assert.equal(count(db, 'recycle_bin', 'restored_at IS NULL'), 0)
  assert.deepEqual(db.sqlite.prepare('SELECT status FROM reservations WHERE id <= 5 ORDER BY id').all().map(x => x.status), STATUSES) // restored exactly as before
})
test('a failure inside the transaction rolls everything back (nothing deleted, no Recycle Bin rows)', async () => {
  const db = seed(); let connection
  db.getConnection(() => {}) // (no-op) ensure adapter connection exists
  const realGet = db.getConnection
  db.getConnection = cb => realGet((error, conn) => { connection = conn; const q = conn.query.bind(conn); conn.query = (sql, values, done) => /^\s*DELETE FROM reservations/.test(String(sql)) ? done(Object.assign(new Error('boom'), { code: 'ER_X' })) : q(sql, values, done); cb(error, conn) })
  const r = await del(db, { ids: [3, 4, 5] })
  assert.equal(r.code, 500); assert.match(r.body.message, /Nothing was deleted/); assert.equal(count(db, 'reservations'), 5); assert.equal(count(db, 'recycle_bin'), 0)
})

// ---- permission: Super Admin only ----
test('the bulk-delete route is guarded by requireRole("MIS") only (MIS Staff = Inventory Staff is not allowed)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/reservationRoutes.js'), 'utf8')
  const line = source.split('\n').find(l => l.includes("'/bulk-delete'")); assert.ok(line); assert.match(line, /requireRole\('MIS'\)/); assert.doesNotMatch(line, /Inventory Staff|Dean|Teacher/)
})
test('the real requireRole("MIS") gate lets Super Admin through and returns 403 for MIS Staff, Dean and Teacher', async () => {
  const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const { createSessionToken } = require('../utils/sessionToken.js')
  const roles = { Teacher: 7, Dean: 8, 'Inventory Staff': 2, MIS: 1 }
  stub('../database/db.js', { query(sql, values, cb) { if (/session_revocations/.test(sql)) return cb(null, []); const id = Number(values[0]); const role = Object.keys(roles).find(name => roles[name] === id); cb(null, [{ id, full_name: role, username: role, role, status: 'ACTIVE' }]) } })
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
  const gate = require('../middleware/roleAuth.js').requireRole('MIS')
  const run = id => new Promise(resolve => { const r = res(); const json = r.json.bind(r); r.json = b => { json(b); resolve({ r, passed: false }); return r }; gate({ header: name => name === 'authorization' ? `Bearer ${createSessionToken(id)}` : '' }, r, () => resolve({ r, passed: true })) })
  assert.equal((await run(1)).passed, true)
  for (const id of [2, 7, 8]) { const out = await run(id); assert.equal(out.passed, false); assert.equal(out.r.code, 403) }
})

// ---- frontend contract (source-level; the page cannot be rendered without Vite/Chromium here) ----
test('Reservations.jsx sends only Completed/Declined/Cancelled rows with valid numeric ids and reports skipped rows', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Reservations.jsx'), 'utf8')
  const fn = page.slice(page.indexOf('async function deleteReservations'), page.indexOf('function openCancel(', page.indexOf('async function deleteReservations')))
  assert.match(page, /DELETABLE_STATUSES = \['COMPLETED', 'DECLINED', 'CANCELLED'\]/); assert.match(fn, /filter\(isDeletable\)/); assert.match(fn, /validId\(item\.id\)/)
  assert.match(fn, /noIdRows/); assert.match(fn, /Pending\/Approved/); assert.match(fn, /await confirm\(/); assert.match(fn, /postDeleteInBatches/)
  assert.match(page, /isMISUser = user\?\.role === 'MIS'/)
})

// ---- CP54: individual / explicit deletion keeps its original behaviour (any status); only Delete All is restricted ----
test('CP54 individual delete: Super Admin can delete a PENDING reservation and an APPROVED one (one at a time), with Recycle Bin snapshots', async () => {
  const db = seed()
  for (const id of [1, 2]) {
    const r = await del(db, { ids: [id] }); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skippedCount, 0); assert.equal(r.body.recycleIds.length, 1)
  }
  assert.deepEqual(remaining(db).map(x => x.status), ['COMPLETED', 'DECLINED', 'CANCELLED'])
  const snaps = db.sqlite.prepare("SELECT snapshot_json FROM recycle_bin WHERE entity_type='reservations' ORDER BY entity_id").all().map(x => JSON.parse(x.snapshot_json).status)
  assert.deepEqual(snaps, ['PENDING', 'APPROVED'])
})
test('CP54 individual delete of every status works (Completed, Declined, Cancelled as before)', async () => {
  const db = seed()
  for (const id of [1, 2, 3, 4, 5]) assert.equal((await del(db, { ids: [id] })).code, 200)
  assert.equal(count(db, 'reservations'), 0); assert.equal(count(db, 'recycle_bin', 'restored_at IS NULL'), 5)
})
test('CP54 Delete Selected (explicit ids, no deleteAll flag) also deletes the ticked rows whatever their status', async () => {
  const db = seed(), r = await del(db, { ids: [1, 2, 3] }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 3); assert.deepEqual(remaining(db).map(x => x.id), [4, 5])
})
test('CP54 same ids, two rules: with deleteAll the Pending/Approved stay; without it they are deleted', async () => {
  const bulk = seed(), single = seed()
  const a = await del(bulk, { ids: [1, 2, 3, 4, 5], deleteAll: true }); const b = await del(single, { ids: [1, 2, 3, 4, 5] })
  assert.equal(a.body.deletedCount, 3); assert.equal(count(bulk, 'reservations'), 2)
  assert.equal(b.body.deletedCount, 5); assert.equal(count(single, 'reservations'), 0)
  assert.equal(a.body.skippedCount, 2); assert.equal(b.body.skippedCount, 0)
})
test('CP54 an individually deleted Pending/Approved reservation is restored exactly from the Recycle Bin', async () => {
  const db = seed(), { bin } = loadControllers(db)
  db.sqlite.prepare("UPDATE reservations SET start_time='10:00:00', end_time='11:00:00' WHERE id=2").run() // fixture rows share one slot; the restore clash check is correct, so separate them
  const r = await del(db, { ids: [1, 2] })
  const back = res(); await bin.restoreRecycleItems({ body: { ids: r.body.recycleIds }, user: MIS }, back); assert.equal(back.code, 200, JSON.stringify(back.body))
  assert.deepEqual(db.sqlite.prepare('SELECT status FROM reservations ORDER BY id').all().map(x => x.status), STATUSES)
})
test('CP54 only the string `true`-valued boolean enables the restriction (truthy strings do not silently change the rule)', async () => {
  const db = seed(), r = await del(db, { ids: [1], deleteAll: 'true' }); assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1)
})
test('CP54 permissions unchanged: the route is Super Admin (MIS) only', () => {
  const line = fs.readFileSync(path.resolve(__dirname, '../routes/reservationRoutes.js'), 'utf8').split('\n').find(l => l.includes("'/bulk-delete'"))
  assert.match(line, /requireRole\('MIS'\)/); assert.doesNotMatch(line, /Inventory Staff|Dean|Teacher/)
})
test('CP54 page: Delete All sends deleteAll:true with deletable rows only; Delete Selected sends the ticked rows of any status', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Reservations.jsx'), 'utf8')
  const fn = page.slice(page.indexOf('async function deleteReservations'), page.indexOf('function openCancel(', page.indexOf('async function deleteReservations')))
  assert.match(fn, /const deleteAll = selectedIds\.length === 0/); assert.match(fn, /deleteAll \? pool\.filter\(isDeletable\) : pool/)
  assert.match(fn, /\{ skipMissing: true, deleteAll: true \}/); assert.match(fn, /await confirm\(/)
})
