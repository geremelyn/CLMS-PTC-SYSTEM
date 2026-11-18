const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const labBefore = { laboratory_name: 'Lab 1', capacity: 30, status: 'OPEN', status_other: null, available_from: '08:00:00', available_until: '17:00:00', booking_interval: 60, available_date_from: null, available_date_until: null, unavailable_from: null, unavailable_until: null, used_from: null, used_until: null, reason: null }
const labAfter = { ...labBefore, status: 'UNAVAILABLE', status_other: 'Under renovation', unavailable_from: new Date('2026-11-09T16:00:00.000Z') }

function load({ rows = [labBefore, labAfter], undo = {}, current } = {}) {
  const calls = []; let selects = 0
  const handle = (sql, values, cb, tx) => {
    const n = sql.replace(/\s+/g, ' ').trim(); calls.push(n)
    if (n.startsWith('SELECT `laboratory_name`') || n.startsWith('SELECT `full_name`')) { const r = tx ? (current ?? rows[1]) : rows[Math.min(selects++, rows.length - 1)]; return cb(null, r ? [r] : []) }
    if (n.startsWith('INSERT INTO undo_actions')) { calls.push({ undoInsert: values }); return cb(null, { insertId: 55 }) }
    if (n.startsWith('SELECT id, entity_type, snapshot_json')) return cb(null, [{ id: 55, entity_type: 'update:laboratories', snapshot_json: JSON.stringify({ table: 'laboratories', id: 3, before: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(labBefore)))), after: { ...labBefore, status: 'UNAVAILABLE', status_other: 'Under renovation', unavailable_from: '2026-11-10 00:00:00' } }), created_by: 1, used_at: null, age: 20, ...undo }])
    if (/^UPDATE (laboratories|users|undo_actions)/.test(n)) { calls.push({ update: n, values }); return cb(null, { affectedRows: 1 }) }
    cb(new Error('Unexpected SQL: ' + n))
  }
  const connection = { beginTransaction: cb => { calls.push('BEGIN'); cb(null) }, commit: cb => { calls.push('COMMIT'); cb(null) }, rollback: cb => { calls.push('ROLLBACK'); cb(null) }, release() {}, query: (s, v, cb) => handle(s, v, cb, true) }
  stub('../database/db.js', { query: (s, v, cb) => handle(s, v, cb, false), getConnection: cb => cb(null, connection) })
  stub('../utils/auditLogger.js', { logAudit() {} })
  delete require.cache[path.resolve(__dirname, '../utils/updateUndo.js')]
  return { mod: require('../utils/updateUndo.js'), calls }
}
const res = () => ({ code: 200, statusCode: 200, body: null, status(c) { this.code = this.statusCode = c; return this }, json(b) { this.body = b; this.done?.(); return this } })

test('a successful lab update gets an undoActionId with before/after snapshots', async () => {
  const { mod, calls } = load(), r = res(), done = new Promise(resolve => { r.done = resolve })
  await mod.withUpdateUndo('laboratories')({ params: { id: '3' }, user: { id: 1 } }, r, () => r.status(200).json({ message: 'Laboratory updated.' }))
  await done
  assert.equal(r.body.undoActionId, 55); assert.equal(r.body.message, 'Laboratory updated.')
  const snap = JSON.parse(calls.find(c => c.undoInsert).undoInsert[1]); assert.equal(snap.before.status, 'OPEN'); assert.equal(snap.after.status_other, 'Under renovation')
  assert.equal(calls.find(c => c.undoInsert).undoInsert[0], 'update:laboratories')
})
test('a failed update returns no undoActionId', async () => {
  const { mod } = load(), r = res(), done = new Promise(resolve => { r.done = resolve })
  await mod.withUpdateUndo('laboratories')({ params: { id: '3' }, user: { id: 1 } }, r, () => r.status(400).json({ message: 'bad' }))
  await done; assert.equal(r.body.undoActionId, undefined)
})
test('undo restores the previous values only for the same user, unchanged record, within the window', async () => {
  const { mod, calls } = load(), r = res()
  await mod.undoRecordUpdate({ params: { undoId: '55' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.ok(calls.includes('COMMIT'))
  const upd = calls.find(c => c.update?.startsWith('UPDATE laboratories')); assert.ok(upd.values.includes('OPEN')); assert.ok(!upd.values.includes('Under renovation'))
})
test('undo is refused when already used, by another user, or when the record changed afterwards', async () => {
  const cases = [[{ undo: { used_at: '2026-01-01' } }, 409], [{ undo: { created_by: 2 } }, 403], [{ current: { ...labAfter, capacity: 99 } }, 409]]
  for (const [opts, code] of cases) { const { mod, calls } = load(opts), r = res(); await mod.undoRecordUpdate({ params: { undoId: '55' }, user: { id: 1, role: 'MIS' } }, r); assert.equal(r.code, code, JSON.stringify(opts)); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(c => c.update?.startsWith('UPDATE laboratories'))) }
})
test('only whitelisted columns are handled; users snapshots never include the password', () => {
  const { mod } = load()
  assert.ok(!mod.TABLES.users.some(c => /pass|hash|token/i.test(c))); assert.ok(mod.TABLES.users.includes('role_other')); assert.ok(mod.TABLES.laboratories.includes('status_other'))
})
