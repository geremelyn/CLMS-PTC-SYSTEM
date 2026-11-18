'use strict'
// CP179 - MOCKED database (NOT real MySQL/MariaDB). In-memory laboratories/computers whose connections emulate InnoDB row locks for
// "SELECT ... FOR UPDATE" (waiters queue until the holder commits/rolls back/releases) including a wait-for-cycle deadlock detector that fails the
// victim with ER_LOCK_DEADLOCK. Async gaps between count and UPDATE make the old count-then-update race reproducible (see the control test).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const tick = () => new Promise(resolve => setImmediate(resolve))
function load({ labs = { 1: 3, 2: 5, 3: 5 }, computers = [], honourLock = true, fail = null, dupIdentifier = false, getConnectionError = false } = {}) {
  const state = { labs: { ...labs }, computers: computers.map(c => ({ condition: 'WORKING', ...c })), sql: [], lockLog: [], order: [], began: 0, committed: 0, rolledBack: 0, released: 0, opened: 0, deadlocks: 0, syncCalls: [], nextId: 500 }
  const locks = new Map()      // key -> { holder, waiters:[{owner,resume}] }
  const waitingFor = new Map() // owner -> key
  const holds = o => [...locks.entries()].filter(([, q]) => q.holder === o).map(([k]) => k)
  const wouldDeadlock = (owner, key) => { let q = locks.get(key); const seen = new Set(); while (q && q.holder && !seen.has(q.holder)) { if (q.holder === owner) return true; seen.add(q.holder); const next = waitingFor.get(q.holder); q = next && locks.get(next) } return false }
  const acquire = (key, owner) => new Promise((resolve, reject) => {
    const q = locks.get(key) || { holder: null, waiters: [] }; locks.set(key, q)
    if (!q.holder || q.holder === owner) { q.holder = owner; return resolve() }
    if (wouldDeadlock(owner, key)) { state.deadlocks++; return reject(Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' })) }
    waitingFor.set(owner, key); q.waiters.push({ owner, resume: () => { waitingFor.delete(owner); q.holder = owner; resolve() } })
  })
  const releaseLocks = owner => { for (const k of holds(owner)) { const q = locks.get(k); q.holder = null; const w = q.waiters.shift(); if (w) w.resume() } }
  const makeConnection = (counted = true) => {
    const owner = Symbol('conn'); if (counted) state.opened++
    return {
      beginTransaction(cb) { state.began++; cb() },
      commit(cb) { if (fail && fail.commit) { releaseLocks(owner); return cb(Object.assign(new Error('commit failed'), {})) } state.committed++; state.commitMark = state.sql.length; releaseLocks(owner); cb() },
      rollback(cb) { state.rolledBack++; releaseLocks(owner); cb() },
      release() { state.released++; releaseLocks(owner) },
      query(sql, values, cb) {
        if (typeof values === 'function') { cb = values; values = [] }
        const n = sql.replace(/\s+/g, ' ').trim(); state.sql.push(n)
        ;(async () => {
          try {
            if (fail && fail.match && fail.match.test(n) && !fail.done) { fail.done = true; return cb(fail.error) }
            if (/^SELECT \* FROM laboratories WHERE ID =\?/.test(n)) { await tick(); return cb(null, state.labs[values[0]] != null ? [{ id: values[0], capacity: state.labs[values[0]] }] : []) }
            if (/^SELECT id, capacity FROM laboratories WHERE id = \? FOR UPDATE$/.test(n)) {
              if (honourLock) await acquire('lab' + values[0], owner); state.order.push([owner, values[0]]); state.lockLog.push(values[0]); await tick()
              return cb(null, state.labs[values[0]] != null ? [{ id: values[0], capacity: state.labs[values[0]] }] : [])
            }
            if (/^SELECT \* FROM laboratories WHERE id=\? FOR UPDATE$/.test(n)) { if (honourLock) await acquire('lab' + values[0], owner); await tick(); return cb(null, state.labs[values[0]] != null ? [{ id: values[0], capacity: state.labs[values[0]] }] : []) }
            if (/^SELECT \* FROM computers WHERE id =\?/.test(n)) { await tick(); return cb(null, state.computers.filter(c => c.id === values[0]).map(c => ({ ...c }))) }
            if (/^SELECT id, laboratory_id, `condition` FROM computers WHERE id = \? FOR UPDATE$/.test(n)) { if (honourLock) await acquire('pc' + values[0], owner); await tick(); return cb(null, state.computers.filter(c => c.id === values[0]).map(c => ({ id: c.id, laboratory_id: c.laboratory_id, condition: c.condition }))) }
            if (n.startsWith('SELECT COUNT(*) AS registeredComputers FROM computers WHERE laboratory_id = ? AND id <> ?')) { const r = state.computers.filter(c => c.laboratory_id === values[0] && c.id !== values[1]).length; await tick(); await tick(); return cb(null, [{ registeredComputers: r }]) }
            if (n.startsWith('SELECT COUNT(*) AS registeredComputers')) { const r = state.computers.filter(c => c.laboratory_id === values[0]).length; await tick(); await tick(); return cb(null, [{ registeredComputers: r }]) }
            if (n.startsWith('UPDATE computers SET')) {
              await tick(); const id = values[values.length - 1], row = state.computers.find(c => c.id === id)
              const guard = /AND laboratory_id = (\d+)$/.exec(n)   // CP180: plain updates are conditional on the laboratory seen by the pre-check
              if (!row || (guard && row.laboratory_id !== Number(guard[1]))) return cb(null, { affectedRows: 0 })
              row.computer_name = values[0]; row.laboratory_id = values[1]; row.condition = values[10]; return cb(null, { affectedRows: 1 })
            }
            if (n.startsWith('INSERT INTO computers')) { await tick(); state.computers.push({ id: state.nextId++, computer_name: values[0], laboratory_id: values[1] }); return cb(null, { insertId: state.nextId - 1 }) }
            if (n.startsWith('SELECT id FROM equipment') || n.startsWith('SELECT id FROM computers')) return cb(null, [])
            cb(new Error('unexpected SQL: ' + n))
          } catch (e) { cb(e) }
        })()
      }
    }
  }
  const db = { query(sql, values, cb) { return makeConnection(false).query(sql, values, cb) }, getConnection(cb) { if (getConnectionError) return cb(new Error('pool down')); cb(null, makeConnection()) } }
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) })
  stub('../utils/assetIdentifierCheck.js', { checkOtherAssetIdentifiers: (d, t, a, s, cb) => cb(null, dupIdentifier) })
  stub('../utils/computerMaintenanceSync.js', { syncComputerMaintenance: (d, o, cb) => { state.syncCalls.push({ at: state.sql.length, committed: state.committed, o, inTxn: d !== db }); cb(null, { action: 'none' }) } })   // CP182: sync runs on the transaction connection
  const cp = path.resolve(__dirname, '../controllers/computerController.js'); delete require.cache[cp]
  return { controller: require(cp), state, audits }
}
const res = () => { let done; const p = new Promise(r => { done = r }); return { code: 200, body: null, p, status(c) { this.code = c; return this }, json(b) { this.body = b; done(this); return this } } }
const body = (n, lab, extra = {}) => ({ computer_name: 'PC-' + n, laboratory_id: lab, asset_tag: 'TAG-' + n, serial_number: 'SN-' + n, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING', ...extra })
const put = (ctx, id, lab, extra) => { const r = res(); ctx.controller.updateComputer({ params: { id: String(id) }, body: body(id, lab, extra), user: { id: 1, role: 'MIS' } }, r); return r.p }
const pcs = (lab, ids) => ids.map(id => ({ id, computer_name: 'PC-' + id, laboratory_id: lab, asset_tag: 'TAG-' + id }))
const inLab = (ctx, lab) => ctx.state.computers.filter(c => c.laboratory_id === lab).length

test('control: WITHOUT the row locks the same mock lets simultaneous transfers exceed the destination capacity (the test can detect the race)', async () => {
  const ctx = load({ labs: { 1: 3, 2: 9, 3: 9 }, computers: [...pcs(1, [1]), ...pcs(2, [10, 11, 12]), ...pcs(3, [20, 21, 22])], honourLock: false })
  await Promise.all([10, 11, 12, 20, 21, 22].map(id => put(ctx, id, 1)))
  assert.ok(inLab(ctx, 1) > 3, 'race should be reproducible without locks: ' + inLab(ctx, 1))
})
test('6 simultaneous transfers from labs 2 and 3 into lab 1 (capacity 3, 1 occupied) -> exactly 2 succeed, 4 get "Laboratory reached its limit"; never above capacity', async () => {
  const ctx = load({ computers: [...pcs(1, [1]), ...pcs(2, [10, 11, 12]), ...pcs(3, [20, 21, 22])] })
  const results = await Promise.all([10, 11, 12, 20, 21, 22].map(id => put(ctx, id, 1)))
  assert.equal(results.filter(r => r.code === 200).length, 2)
  const refused = results.filter(r => r.code === 400); assert.equal(refused.length, 4); assert.ok(refused.every(r => r.body.message === 'Laboratory reached its limit'))
  assert.equal(inLab(ctx, 1), 3); assert.equal(ctx.state.deadlocks, 0)
  assert.equal(ctx.state.released, ctx.state.opened)
})
test('transfers into a lab that is already full are all refused and nothing is updated', async () => {
  const ctx = load({ labs: { 1: 2, 2: 5 }, computers: [...pcs(1, [1, 2]), ...pcs(2, [10, 11])] })
  const results = await Promise.all([10, 11].map(id => put(ctx, id, 1)))
  assert.ok(results.every(r => r.code === 400)); assert.equal(inLab(ctx, 1), 2); assert.equal(inLab(ctx, 2), 2)
})
test('a transfer and a create racing for the LAST free slot of a laboratory: exactly one wins (create and transfer share the lab row lock)', async () => {
  const ctx = load({ labs: { 1: 2, 2: 5 }, computers: [...pcs(1, [1]), ...pcs(2, [10])] })
  const createBody = { ...body(99, 1), asset_tag: 'TAG-99' }, c = res(); ctx.controller.createComputer({ body: createBody, user: { id: 1 } }, c)
  const results = await Promise.all([c.p, put(ctx, 10, 1)])
  assert.equal(results.filter(r => r.code === 400).length, 1); assert.equal(results.filter(r => r.code === 200 || r.code === 201).length, 1)
  assert.equal(inLab(ctx, 1), 2)
})
test('opposite transfers (lab1->lab2 and lab2->lab1) take the locks in ascending laboratory-id order and never deadlock', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: [...pcs(1, [10]), ...pcs(2, [20])] })
  const [a, b] = await Promise.all([put(ctx, 10, 2), put(ctx, 20, 1)])
  assert.equal(a.code, 200); assert.equal(b.code, 200); assert.equal(ctx.state.deadlocks, 0)
  const per = new Map(); for (const [owner, lab] of ctx.state.order) per.set(owner, [...(per.get(owner) || []), lab])
  assert.equal(per.size, 2); for (const labsLocked of per.values()) assert.deepEqual(labsLocked, [1, 2])
  assert.equal(ctx.state.computers.find(c => c.id === 10).laboratory_id, 2); assert.equal(ctx.state.computers.find(c => c.id === 20).laboratory_id, 1)
})
test('three-way rotation (1->2, 2->3, 3->1) with ample capacity: all succeed, ascending lock order, no deadlock', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5, 3: 5 }, computers: [...pcs(1, [10]), ...pcs(2, [20]), ...pcs(3, [30])] })
  const r = await Promise.all([put(ctx, 10, 2), put(ctx, 20, 3), put(ctx, 30, 1)])
  assert.ok(r.every(x => x.code === 200)); assert.equal(ctx.state.deadlocks, 0)
  const per = new Map(); for (const [owner, lab] of ctx.state.order) per.set(owner, [...(per.get(owner) || []), lab]); for (const l of per.values()) assert.deepEqual(l, [...l].sort((x, y) => x - y))
})
test('SQL order for one transfer: lock lower lab id, lock higher lab id, lock computer, count (excluding the moving computer), UPDATE; one transaction, committed', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: [...pcs(2, [10])] })
  const r = await put(ctx, 10, 1); assert.equal(r.code, 200)
  const idx = re => ctx.state.sql.findIndex(s => re.test(s))
  const l1 = idx(/FROM laboratories WHERE id = \? FOR UPDATE/), pc = idx(/FROM computers WHERE id = \? FOR UPDATE/), cnt = idx(/id <> \?/), up = idx(/^UPDATE computers SET/)
  assert.ok(l1 >= 0 && l1 < pc && pc < cnt && cnt < up, ctx.state.sql.join(' | '))
  assert.deepEqual(ctx.state.lockLog, [1, 2]); assert.equal(ctx.state.began, 1); assert.equal(ctx.state.committed, 1); assert.equal(ctx.state.rolledBack, 0)
})
test('the computer being moved is NOT counted against the destination: a destination with capacity 2 and 1 occupant accepts it, and a concurrent duplicate request for the same computer also succeeds', async () => {
  const ctx = load({ labs: { 1: 2, 2: 5 }, computers: [...pcs(1, [1]), ...pcs(2, [10])] })
  const [a, b] = await Promise.all([put(ctx, 10, 1), put(ctx, 10, 1)])
  assert.equal(a.code, 200); assert.equal(b.code, 200, 'second request finds the computer already in the destination -> no capacity check'); assert.equal(inLab(ctx, 1), 2)
})
test('same-laboratory updates: no capacity check and no laboratory locks (CP182: one short transaction on the computer row only); response and audit unchanged, even when the laboratory is full', async () => {
  const ctx = load({ labs: { 1: 1 }, computers: pcs(1, [1]) })
  const r = await put(ctx, 1, 1, { computer_name: 'Renamed' })
  assert.equal(r.code, 200); assert.equal(r.body.message, 'Computer updated successfully'); assert.equal(ctx.state.computers[0].computer_name, 'Renamed')
  assert.ok(ctx.audits.some(a => a[1] === 'ASSET UPDATE' && /Updated workstation/.test(a[2]))); assert.equal(ctx.state.began, 1); assert.equal(ctx.state.committed, 1); assert.equal(ctx.state.lockLog.length, 0, 'no laboratory row is locked'); assert.ok(!ctx.state.sql.some(x => /COUNT\(\*\)/.test(x)), 'no capacity count')
})
test('transfer success keeps response body, WORKSTATION ASSIGNMENT audit, and (CP182) runs the maintenance sync INSIDE the transaction, before the commit', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) })
  const r = await put(ctx, 10, 1, { condition: 'NOT WORKING', condition_note: 'No signal' }); assert.equal(r.code, 200)
  assert.equal(r.body.computer.laboratory_id, 1); assert.equal(r.body.computer.id, '10'); assert.deepEqual(r.body.maintenance, { action: 'none' })
  assert.ok(ctx.audits.some(a => a[1] === 'WORKSTATION ASSIGNMENT' && /Transferred workstation PC-10 \(TAG-10\) to laboratory #1/.test(a[2])))
  assert.equal(ctx.state.syncCalls.length, 1); assert.equal(ctx.state.syncCalls[0].committed, 0, 'sync runs before the commit, on the transaction connection'); assert.equal(ctx.state.syncCalls[0].inTxn, true); assert.equal(ctx.state.syncCalls[0].o.before, 'WORKING'); assert.equal(ctx.state.syncCalls[0].o.after, 'NOT WORKING')
})
test('validation and pre-checks are preserved and open no transaction (400 validation, 404 destination laboratory, 404 computer)', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) })
  let r = res(); ctx.controller.updateComputer({ params: { id: '10' }, body: { ...body(10, 1), ram: 'x' } }, r); assert.equal(r.code, 400)
  r = await put(ctx, 10, 9); assert.equal(r.code, 404); assert.equal(r.body.message, 'Laboratory not found')
  r = await put(ctx, 77, 1); assert.equal(r.code, 404); assert.equal(r.body.message, 'Computer not found')
  assert.equal(ctx.state.began, 0)
})
test('failure: UPDATE hits a duplicate key -> 409, rolled back, computer unchanged, connection released, lock freed so the next transfer proceeds', async () => {
  const fail = { match: /^UPDATE computers SET/, error: Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }) }
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10, 11]), fail })
  const [a, b] = await Promise.all([put(ctx, 10, 1), put(ctx, 11, 1)])
  assert.deepEqual([a.code, b.code].sort(), [200, 409]); assert.match([a, b].find(x => x.code === 409).body.message, /Identifiers must be unique/)
  assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.committed, 1); assert.equal(ctx.state.released, ctx.state.opened); assert.equal(inLab(ctx, 1), 1)
})
test('failure: other UPDATE error -> 500 "Unable to update computer" with the error text, rolled back, released', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), fail: { match: /^UPDATE computers SET/, error: new Error('disk full') } })
  const r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to update computer'); assert.equal(r.body.error, 'disk full')
  assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.released, ctx.state.opened); assert.equal(inLab(ctx, 2), 1)
})
test('failure: count error -> 500 "Unable to count registered computers"; lock error -> 500 "Unable to check laboratory"; both rolled back and released', async () => {
  let ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), fail: { match: /COUNT\(\*\)/, error: new Error('x') } })
  let r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to count registered computers'); assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.released, ctx.state.opened)
  ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), fail: { match: /FROM laboratories WHERE id = \? FOR UPDATE/, error: new Error('lock wait timeout') } })
  r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to check laboratory'); assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.released, ctx.state.opened)
})
test('failure: deadlock/lock error on the computer row -> 500 "Unable to check computer", rolled back and released', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), fail: { match: /FROM computers WHERE id = \? FOR UPDATE/, error: Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }) } })
  const r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to check computer'); assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.released, ctx.state.opened)
})
test('failure: identifier check error / identifier duplicate -> 500 / 409 with the original messages, rolled back/released, nothing moved', async () => {
  let ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), dupIdentifier: true })
  let r = await put(ctx, 10, 1); assert.equal(r.code, 409); assert.equal(r.body.message, 'Asset tag or serial number already exists on an equipment record.'); assert.equal(inLab(ctx, 2), 1); assert.equal(ctx.state.released, ctx.state.opened)
})
test('failure: commit fails -> 500 "Unable to update computer", released, lock freed; pool failure -> 500 "Unable to check laboratory"', async () => {
  let ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), fail: { commit: true } })
  let r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to update computer'); assert.equal(ctx.state.released, ctx.state.opened); assert.equal(ctx.audits.length, 0, 'no audit entry for a failed edit')
  ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]), getConnectionError: true })
  r = await put(ctx, 10, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to check laboratory')
})
test('race: destination laboratory is removed or the computer is deleted between the pre-check and the locks -> 404, rolled back-free exit, released', async () => {
  let ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) }); const origQuery = require(path.resolve(__dirname, '../database/db.js')).query
  const db = require(path.resolve(__dirname, '../database/db.js')); const gc = db.getConnection
  db.getConnection = cb => { delete ctx.state.labs[1]; gc(cb) }   // destination disappears right before the transaction starts
  let r = await put(ctx, 10, 1); assert.equal(r.code, 404); assert.equal(r.body.message, 'Laboratory not found'); assert.equal(ctx.state.released, ctx.state.opened); assert.equal(inLab(ctx, 2), 1)
  ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) }); const db2 = require(path.resolve(__dirname, '../database/db.js')); const gc2 = db2.getConnection
  db2.getConnection = cb => { ctx.state.computers.length = 0; gc2(cb) }
  r = await put(ctx, 10, 1); assert.equal(r.code, 404); assert.equal(r.body.message, 'Computer not found'); assert.equal(ctx.state.released, ctx.state.opened); void origQuery
})
