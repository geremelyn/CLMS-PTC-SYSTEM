'use strict'
// CP178 A2 - MOCKED database (NOT real MySQL/MariaDB). An in-memory laboratories/computers store whose connections emulate InnoDB row locks:
// "SELECT ... FOR UPDATE" on a laboratory waits until the holder commits/rolls back. Async gaps between the count and the insert make the old
// count-then-insert race reproducible (see the "lock disabled" control test), so the passing tests show the transaction + lock is what protects capacity.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const tick = () => new Promise(resolve => setImmediate(resolve))
function load({ capacity = 2, existing = 0, honourLock = true, failInsertAt = null, failCommit = false } = {}) {
  const state = { computers: Array.from({ length: existing }, (_, i) => ({ id: i + 1, computer_name: 'old' + i, laboratory_id: 1 })), nextId: 100, sql: [], began: 0, committed: 0, rolledBack: 0, released: 0, opened: 0, inserts: 0 }
  const locks = new Map()   // laboratory id -> queue of waiters
  const acquire = (labId, owner) => new Promise(resolve => { const q = locks.get(labId) || { holder: null, waiters: [] }; locks.set(labId, q); if (!q.holder) { q.holder = owner; resolve() } else q.waiters.push(() => { q.holder = owner; resolve() }) })
  const releaseLocks = owner => { for (const q of locks.values()) if (q.holder === owner) { q.holder = null; const next = q.waiters.shift(); if (next) next() } }
  const makeConnection = () => {
    const owner = Symbol('conn'); state.opened++
    const c = {
      beginTransaction(cb) { state.began++; cb() },
      commit(cb) { if (failCommit) { releaseLocks(owner); return cb(new Error('commit failed')) } state.committed++; releaseLocks(owner); cb() },
      rollback(cb) { state.rolledBack++; releaseLocks(owner); cb() },
      release() { state.released++; releaseLocks(owner) },
      query(sql, values, cb) {
        if (typeof values === 'function') { cb = values; values = [] }
        const n = sql.replace(/\s+/g, ' ').trim(); state.sql.push(n)
        ;(async () => {
          try {
            if (/^SELECT .* FROM laboratories WHERE id=\?/.test(n)) {
              if (/FOR UPDATE$/.test(n) && honourLock) await acquire(values[0], owner)
              await tick(); return cb(null, values[0] === 1 ? [{ id: 1, capacity }] : [])
            }
            if (n.startsWith('SELECT COUNT(*) AS registeredComputers')) { const r = [{ registeredComputers: state.computers.filter(x => x.laboratory_id === values[0]).length }]; await tick(); await tick(); return cb(null, r) }
            if (n.startsWith('SELECT id, LOWER(computer_name)')) { const r = state.computers.filter(x => x.laboratory_id === values[0]).map(x => ({ id: x.id, lname: x.computer_name.toLowerCase() })); await tick(); await tick(); return cb(null, r) }
            if (n.startsWith('INSERT INTO computers')) {
              state.inserts++; if (failInsertAt === state.inserts) return cb(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }))
              await tick(); const id = state.nextId++; state.computers.push({ id, computer_name: values[0], laboratory_id: values[1] }); return cb(null, { insertId: id })
            }
            if (n.startsWith('SELECT id FROM equipment') || n.startsWith('SELECT id FROM computers')) return cb(null, [])
            cb(new Error('unexpected SQL: ' + n))
          } catch (e) { cb(e) }
        })()
      }
    }
    return c
  }
  const db = { query(sql, values, cb) { return makeConnection().query(sql, values, cb) }, getConnection(cb) { cb(null, makeConnection()) } }
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) })
  stub('../utils/computerMaintenanceSync.js', { syncComputerMaintenance: (d, o, cb) => cb(null, { action: 'none' }) })
  const cp = path.resolve(__dirname, '../controllers/computerController.js'); delete require.cache[cp]
  return { controller: require(cp), state, audits }
}
const res = () => { let done; const p = new Promise(r => { done = r }); return { code: 200, body: null, p, status(c) { this.code = c; return this }, json(b) { this.body = b; done(this); return this } } }
const full = n => ({ computer_name: 'PC-' + n, laboratory_id: 1, asset_tag: 'TAG-' + n, serial_number: 'SN-' + n, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' })
const create = (ctx, n) => { const r = res(); ctx.controller.createComputer({ body: full(n), user: { id: 1 } }, r); return r.p }
const quick = (ctx, n) => { const r = res(); ctx.controller.createQuickComputer({ body: { computer_name: 'Q-' + n, laboratory_id: 1 }, user: { id: 1 } }, r); return r.p }

test('control: WITHOUT the row lock the same mock lets simultaneous creates exceed capacity (proves the test can detect the race)', async () => {
  const ctx = load({ capacity: 1, honourLock: false })
  const results = await Promise.all([1, 2, 3, 4].map(n => create(ctx, n)))
  assert.ok(results.filter(r => r.code === 201).length > 1, 'race should be reproducible without the lock')
})
test('A2: 8 simultaneous creates into a lab with capacity 3 and 1 existing -> exactly 2 succeed, 6 get "Laboratory reached its limit"; never above capacity', async () => {
  const ctx = load({ capacity: 3, existing: 1 })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => create(ctx, i + 1)))
  assert.equal(results.filter(r => r.code === 201).length, 2)
  const refused = results.filter(r => r.code === 400); assert.equal(refused.length, 6)
  assert.ok(refused.every(r => r.body.message === 'Laboratory reached its limit'))
  assert.equal(ctx.state.computers.length, 3)
})
test('A2: simultaneous creates into a lab that is already full -> all refused, nothing inserted', async () => {
  const ctx = load({ capacity: 2, existing: 2 })
  const results = await Promise.all([1, 2, 3].map(n => create(ctx, n)))
  assert.ok(results.every(r => r.code === 400)); assert.equal(ctx.state.inserts, 0)
})
test('A2: simultaneous QUICK creates (Equipment form shortcut) also respect capacity', async () => {
  const ctx = load({ capacity: 2, existing: 0 })
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => quick(ctx, n)))
  assert.equal(results.filter(r => r.code === 201).length, 2); assert.equal(results.filter(r => r.code === 400).length, 3); assert.equal(ctx.state.computers.length, 2)
})
test('A2: a mix of full creates and quick creates shares the same capacity', async () => {
  const ctx = load({ capacity: 2 })
  const results = await Promise.all([create(ctx, 1), quick(ctx, 2), create(ctx, 3), quick(ctx, 4)])
  assert.equal(results.filter(r => r.code === 201).length, 2); assert.equal(ctx.state.computers.length, 2)
})
test('A2: the laboratory row is locked with FOR UPDATE BEFORE the count, inside a transaction (SQL order)', async () => {
  const ctx = load({ capacity: 5 }); const r = await create(ctx, 1); assert.equal(r.code, 201)
  const lock = ctx.state.sql.findIndex(s => /FROM laboratories WHERE id=\? FOR UPDATE$/.test(s)), count = ctx.state.sql.findIndex(s => s.startsWith('SELECT COUNT(*)')), ins = ctx.state.sql.findIndex(s => s.startsWith('INSERT INTO computers'))
  assert.ok(lock >= 0 && lock < count && count < ins, ctx.state.sql.join(' | '))
  assert.equal(ctx.state.began, 1); assert.equal(ctx.state.committed, 1); assert.equal(ctx.state.rolledBack, 0)
})
test('A2: responses and validation are preserved (201 body, audit, 400 validation, 404 laboratory, 409 duplicate insert) and every connection is released', async () => {
  let ctx = load({ capacity: 5 }); let r = await create(ctx, 1)
  assert.equal(r.code, 201); assert.equal(r.body.message, 'Computer created successfully'); assert.equal(r.body.computer.asset_tag, 'TAG-1'); assert.equal(r.body.computer.laboratory_id, 1)
  assert.ok(ctx.audits.some(a => a[1] === 'WORKSTATION ASSIGNMENT')); assert.equal(ctx.state.released, ctx.state.opened)
  const bad = res(); ctx.controller.createComputer({ body: { ...full(2), ram: 'x' } }, bad); assert.equal(bad.code, 400); assert.equal(ctx.state.opened, 1, 'validation failure must not open a connection')
  const nolab = res(); ctx.controller.createComputer({ body: { ...full(3), laboratory_id: 9 } }, nolab); await nolab.p; assert.equal(nolab.code, 404); assert.equal(nolab.body.message, 'Laboratory not found'); assert.equal(ctx.state.rolledBack, 0); assert.equal(ctx.state.released, ctx.state.opened)
  ctx = load({ capacity: 5, failInsertAt: 1 }); r = await create(ctx, 1)
  assert.equal(r.code, 409); assert.match(r.body.message, /Identifiers must be unique/); assert.equal(ctx.state.rolledBack, 1); assert.equal(ctx.state.committed, 0); assert.equal(ctx.state.released, ctx.state.opened); assert.equal(ctx.state.computers.length, 0)
})
test('A2: a failed insert releases the laboratory lock - the next create is not blocked and succeeds', async () => {
  const ctx = load({ capacity: 5, failInsertAt: 1 })
  const [a, b] = await Promise.all([create(ctx, 1), create(ctx, 2)])
  assert.deepEqual([a.code, b.code].sort(), [201, 409]); assert.equal(ctx.state.computers.length, 1)
})
test('A2: commit failure -> 500 "Unable to create computer", rolled back/released, lock freed', async () => {
  const ctx = load({ capacity: 5, failCommit: true }); const r = await create(ctx, 1)
  assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to create computer'); assert.equal(ctx.state.released, ctx.state.opened)
})
test('A2: connection pool failure -> 500 "Unable to check laboratory"', async () => {
  const ctx = load({ capacity: 5 }); const dbp = require(path.resolve(__dirname, '../database/db.js')); dbp.getConnection = cb => cb(new Error('pool down'))
  const r = await create(ctx, 1); assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to check laboratory')
})
test('A2: quick create keeps its 409 duplicate-name and 400 limit messages', async () => {
  let ctx = load({ capacity: 5, existing: 0 }); ctx.state.computers.push({ id: 50, computer_name: 'Q-1', laboratory_id: 1 })
  let r = await quick(ctx, 1); assert.equal(r.code, 409); assert.equal(r.body.message, 'A computer with this name already exists in that laboratory.')
  ctx = load({ capacity: 1, existing: 1 }); r = await quick(ctx, 9); assert.equal(r.code, 400); assert.equal(r.body.message, 'Laboratory reached its limit')
})
