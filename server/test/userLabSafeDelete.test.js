const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const user = (id, extra = {}) => ({ id, full_name: `User ${id}`, username: `U${id}`, password: 'HASH', role: 'Teacher', status: 'ACTIVE', program: 'BSIT', ...extra })
// usage: rows referencing each id, by table.column
function load({ users = [], labs = [], usage = {}, binRows = {}, existingUsername = false, existingLabName = false, existingId = false, failDelete = false } = {}) {
  const calls = [], inserted = []
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() {},
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push(n)
      if (n.startsWith('SELECT * FROM users WHERE id IN')) return cb(null, users.filter(u => values.includes(u.id)))
      if (n.startsWith('SELECT * FROM laboratories WHERE id IN')) return cb(null, labs.filter(l => values.includes(l.id)))
      let m = n.match(/^SELECT (\w+) AS id, COUNT\(\*\) AS total FROM (\w+) WHERE \w+ IN/)
      if (m) { const rows = (usage[`${m[2]}.${m[1]}`] || []).filter(id => values.includes(id)).map(id => ({ id, total: 2 })); return cb(null, rows) }
      if (n.startsWith('INSERT INTO recycle_bin')) { inserted.push(...values[0]); return cb(null, { affectedRows: values[0].length }) }
      if (n.startsWith('DELETE FROM')) return cb(null, { affectedRows: failDelete ? 0 : values.length })
      if (n.startsWith('SELECT id FROM recycle_bin WHERE entity_type = ?')) return cb(null, values.slice(1).map((v, i) => ({ id: 200 + i })))
      if (n.startsWith('SELECT * FROM recycle_bin WHERE id = ?')) return cb(null, binRows[values[0]] ? [binRows[values[0]]] : [])
      if (n.startsWith('SELECT id FROM users WHERE id = ?') || n.startsWith('SELECT id FROM laboratories WHERE id = ?')) return cb(null, existingId ? [{ id: 1 }] : [])
      if (n.startsWith('SELECT id FROM users WHERE username')) return cb(null, existingUsername ? [{ id: 9 }] : [])
      if (n.startsWith('SELECT id FROM laboratories WHERE LOWER(laboratory_name)')) return cb(null, existingLabName ? [{ id: 9 }] : [])
      if (n.startsWith('INSERT INTO users') || n.startsWith('INSERT INTO laboratories')) { calls.push({ restoreInsert: n, values }); return cb(null, { affectedRows: 1 }) }
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

test('deleting unused users moves them to the Recycle Bin (snapshot incl. hash for restore), no password in the response', async () => {
  const { controller, calls, inserted } = load({ users: [user(5), user(6)] }), r = res()
  await controller.deleteUsers({ body: { ids: [5, 6] }, user: mis }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.deletedCount, 2); assert.match(r.body.message, /^Successfully deleted 2 users/)
  assert.ok(!JSON.stringify(r.body).includes('HASH')); assert.equal(inserted[0][0], 'users'); assert.ok(calls.includes('COMMIT'))
  assert.ok(JSON.parse(inserted[0][3]).password === 'HASH', 'hash is kept in the DB snapshot so login works after restore')
})
test('users that are MIS, yourself, or in use are skipped with a reason; the rest are deleted', async () => {
  const users = [user(1, { role: 'MIS' }), user(2, { id: 2 }), user(3), user(4), user(5)]
  const { controller, inserted } = load({ users, usage: { 'reservations.reserved_by': [3], 'maintenance.reported_by': [4] } }), r = res()
  await controller.deleteUsers({ body: { ids: [1, 2, 3, 4, 5] }, user: { id: 2, role: 'MIS' } }, r)
  assert.equal(r.code, 200); assert.equal(r.body.deletedCount, 1); assert.equal(r.body.skippedCount, 4); assert.equal(inserted.length, 1)
  const reasons = Object.fromEntries(r.body.skipped.map(s => [s.id, s.reason]))
  assert.match(reasons[1], /MIS/); assert.match(reasons[2], /own account/); assert.match(reasons[3], /reservation history/); assert.match(reasons[4], /maintenance reports/)
  assert.match(r.body.message, /could not be deleted/)
})
test('if nothing can be deleted the API says so (409) and deletes nothing — no fake success', async () => {
  const { controller, calls } = load({ users: [user(3)], usage: { 'reservations.reserved_by': [3] } }), r = res()
  await controller.deleteUsers({ body: { ids: [3] }, user: mis }, r)
  assert.equal(r.code, 409); assert.match(r.body.message, /Nothing was deleted/); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(c => typeof c === 'string' && c.startsWith('DELETE FROM')))
})
test('laboratories in use by computers, equipment or reservations cannot be deleted; unused ones can', async () => {
  const labs = [{ id: 1, laboratory_name: 'Lab 1' }, { id: 2, laboratory_name: 'Lab 2' }]
  const used = load({ labs, usage: { 'computers.laboratory_id': [1], 'reservations.laboratory_id': [1] } }), r1 = res()
  await used.controller.deleteLaboratories({ body: { ids: [1] }, user: mis }, r1)
  assert.equal(r1.code, 409); assert.match(r1.body.message, /2 computers, 2 reservations/)
  const free = load({ labs, usage: { 'computers.laboratory_id': [1] } }), r2 = res()
  await free.controller.deleteLaboratories({ body: { ids: [1, 2] }, user: mis }, r2)
  assert.equal(r2.code, 200); assert.equal(r2.body.deletedCount, 1); assert.equal(r2.body.skipped[0].id, 1)
})
test('delete validates input and rolls back on a count mismatch', async () => {
  for (const ids of [[], 'x', [0], [-1], Array.from({ length: 5001 }, (_, i) => i + 1)]) { const { controller } = load(), r = res(); await controller.deleteUsers({ body: { ids }, user: mis }, r); assert.equal(r.code, 400) }
  const { controller, calls } = load({ users: [user(5)], failDelete: true }), r = res()
  await controller.deleteUsers({ body: { ids: [5] }, user: mis }, r)
  assert.equal(r.code, 500); assert.ok(calls.includes('ROLLBACK'))
})
test('restoring a user/laboratory re-inserts the same row; refused when the ID number, name or ID is taken', async () => {
  const bin = { 300: { id: 300, entity_type: 'users', entity_id: 5, label: 'User 5', restored_at: null, snapshot_json: JSON.stringify(user(5)) }, 301: { id: 301, entity_type: 'laboratories', entity_id: 7, label: 'Lab 7', restored_at: null, snapshot_json: JSON.stringify({ id: 7, laboratory_name: 'Lab 7', capacity: 30, status: 'OPEN' }) } }
  const ok = load({ binRows: bin }), r = res()
  await ok.controller.restoreRecycleItems({ body: { ids: [300, 301] }, user: mis }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.restoredCount, 2); assert.equal(ok.calls.filter(c => c.restoreInsert).length, 2)
  for (const [opts, ids, text] of [[{ existingUsername: true }, [300], /ID number/], [{ existingLabName: true }, [301], /already exists/], [{ existingId: true }, [300], /ID already exists/]]) {
    const t = load({ binRows: bin, ...opts }), x = res(); await t.controller.restoreRecycleItems({ body: { ids }, user: mis }, x)
    assert.equal(x.code, 409, JSON.stringify(opts)); assert.match(x.body.message, text); assert.ok(t.calls.includes('ROLLBACK'))
  }
})
test('the Recycle Bin list never sends a password hash to the browser', async () => {
  const stubDb = { query: (s, v, cb) => cb(null, [{ id: 1, entity_type: 'users', entity_id: 5, label: 'User 5', snapshot_json: JSON.stringify(user(5)), deleted_at: 'now', deleted_by_name: 'Admin' }]), getConnection() {} }
  stub('../database/db.js', stubDb); stub('../utils/auditLogger.js', { logAudit() {} })
  for (const f of ['bulkRecordController', 'recycleBinController']) delete require.cache[path.resolve(__dirname, `../controllers/${f}.js`)]
  const r = res(); await require('../controllers/recycleBinController.js').listRecycleBin({ query: {} }, r)
  assert.ok(!JSON.stringify(r.body).includes('HASH')); assert.equal(r.body.items[0].snapshot.username, 'U5')
})
