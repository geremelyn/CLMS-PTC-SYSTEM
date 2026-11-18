'use strict'
// CP182 - MOCKED database (NOT real MySQL/MariaDB). In-memory computers + maintenance tables; connections emulate InnoDB row locks for "... FOR UPDATE"
// (waiters queue until commit/rollback/release) and keep an UNDO log so rollback really restores computer condition and maintenance rows.
// The REAL utils/computerMaintenanceSync.js runs against it (its INSERT ... SELECT / UPDATE statements are interpreted by the mock).
// Invariant checked after every scenario: computer WORKING  => no open maintenance record; computer not working => exactly one open record.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const tick = () => new Promise(resolve => setImmediate(resolve))
const ticks = async n => { for (let i = 0; i < n; i++) await tick() }
const OPEN = ['PENDING', 'IN PROGRESS']
function load({ condition = 'WORKING', lab = 1, maintenance = [], honourLock = true, syncFail = null, updateFail = null, commitFail = false, extraComputers = [] } = {}) {
  const st = { computer: { id: 5, computer_name: 'PC-05', laboratory_id: lab, asset_tag: 'A5', condition, condition_note: null }, others: extraComputers, labs: { 1: 50, 2: 50 }, maintenance: maintenance.map(m => ({ ...m })), nextId: 100, began: 0, committed: 0, rolledBack: 0, released: 0, opened: 0, syncSql: [] }
  const locks = new Map()
  const acquire = (key, owner) => new Promise(resolve => { const q = locks.get(key) || { holder: null, waiters: [] }; locks.set(key, q); if (!q.holder || q.holder === owner) { q.holder = owner; return resolve() } q.waiters.push(() => { q.holder = owner; resolve() }) })
  const releaseAll = owner => { for (const q of locks.values()) if (q.holder === owner) { q.holder = null; const w = q.waiters.shift(); if (w) w() } }
  const mk = (counted = true) => {
    const owner = Symbol('c'); if (counted) st.opened++
    const undo = []
    return {
      beginTransaction(cb) { st.began++; cb() },
      commit(cb) { if (commitFail) { return cb(new Error('commit failed')) } st.committed++; undo.length = 0; releaseAll(owner); cb() },
      rollback(cb) { st.rolledBack++; while (undo.length) undo.pop()(); releaseAll(owner); cb() },
      release() { st.released++; releaseAll(owner) },
      query(sql, values, cb) {
        if (typeof values === 'function') { cb = values; values = [] }
        const n = sql.replace(/\s+/g, ' ').trim()
        ;(async () => {
          try {
            await tick()
            if (/^SELECT \* FROM laboratories WHERE ID =\?/.test(n)) return cb(null, st.labs[values[0]] != null ? [{ id: values[0], capacity: st.labs[values[0]] }] : [])
            if (/^SELECT \* FROM computers WHERE id =\?/.test(n)) return cb(null, values[0] === 5 ? [{ ...st.computer }] : [])
            if (/^SELECT id, capacity FROM laboratories WHERE id = \? FOR UPDATE$/.test(n)) { if (honourLock) await acquire('lab' + values[0], owner); await tick(); return cb(null, st.labs[values[0]] != null ? [{ id: values[0], capacity: st.labs[values[0]] }] : []) }
            if (/^SELECT id, laboratory_id, `condition` FROM computers WHERE id = \? FOR UPDATE$/.test(n)) { if (honourLock) await acquire('pc' + values[0], owner); await tick(); return cb(null, values[0] === 5 ? [{ id: 5, laboratory_id: st.computer.laboratory_id, condition: st.computer.condition }] : []) }
            if (/^SELECT COUNT\(\*\) AS registeredComputers/.test(n)) return cb(null, [{ registeredComputers: 0 }])
            if (/^UPDATE computers SET/.test(n)) {
              if (updateFail) { const e = updateFail; updateFail = null; return cb(e) }
              const id = values[values.length - 1]; if (id !== 5) return cb(null, { affectedRows: 0 })
              const guard = /AND laboratory_id = (\d+)$/.exec(n); if (guard && st.computer.laboratory_id !== Number(guard[1])) return cb(null, { affectedRows: 0 })
              const prev = { ...st.computer }; undo.push(() => { st.computer = prev })
              st.computer = { ...st.computer, computer_name: values[0], laboratory_id: values[1], condition: values[10], condition_note: values[11] }; return cb(null, { affectedRows: 1 })
            }
            if (/maintenance/.test(n)) {
              st.syncSql.push(n)
              if (syncFail) { const e = syncFail; if (!e.once || !e.used) { e.used = true; return cb(Object.assign(new Error(e.message || 'sync failed'), { code: e.code })) } }
              if (/^INSERT INTO maintenance/.test(n)) {
                if (st.maintenance.some(r => r.computer_id === values[3] && OPEN.includes(r.status))) return cb(null, { affectedRows: 0, insertId: 0 })
                const row = { id: st.nextId++, computer_id: values[0], reported_by: values[1], issue_description: values[2], status: 'PENDING', date_resolved: null }
                st.maintenance.push(row); undo.push(() => { st.maintenance = st.maintenance.filter(r => r !== row) }); return cb(null, { affectedRows: 1, insertId: row.id })
              }
              if (/^UPDATE maintenance SET status = 'COMPLETED'/.test(n)) {
                let count = 0; for (const r of st.maintenance) if (r.computer_id === values[0] && OPEN.includes(r.status)) { const prev = { ...r }; undo.push(() => Object.assign(r, prev)); r.status = 'COMPLETED'; r.date_resolved = 'NOW'; count++ }
                return cb(null, { affectedRows: count })
              }
            }
            cb(new Error('unexpected SQL: ' + n))
          } catch (e) { cb(e) }
        })()
      }
    }
  }
  const db = { query(sql, values, cb) { return mk(false).query(sql, values, cb) }, getConnection(cb) { cb(null, mk()) } }
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) }); stub('../utils/assetIdentifierCheck.js', { checkOtherAssetIdentifiers: (d, t, a, s, cb) => cb(null, false) })
  for (const f of ['controllers/computerController.js', 'utils/computerMaintenanceSync.js']) delete require.cache[path.resolve(__dirname, '../' + f)]
  return { controller: require('../controllers/computerController.js'), st, audits, db }
}
const res = () => { let done; const p = new Promise(r => { done = r }); return { code: 200, body: null, p, status(c) { this.code = c; return this }, json(b) { this.body = b; done(this); return this } } }
const body = (condition, lab = 1, note = null) => ({ computer_name: 'PC-05', laboratory_id: lab, asset_tag: 'A5', serial_number: 'S5', processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition, condition_note: note })
const put = (ctx, condition, { lab = 1, note = condition === 'WORKING' ? null : 'note', delay = 0, user = { id: 2, role: 'MIS' } } = {}) => { const r = res(); setTimeout(() => ctx.controller.updateComputer({ params: { id: '5' }, body: body(condition, lab, note), user }, r), 0); return delay ? ticks(delay).then(() => { /* delay applied below */ return r.p }) : r.p }
// start a request after `delay` event-loop turns
const putLater = async (ctx, condition, delay, opts = {}) => { await ticks(delay); return put(ctx, condition, opts) }
const openRecords = ctx => ctx.st.maintenance.filter(r => OPEN.includes(r.status))
const isWorking = c => String(c).trim().toUpperCase() === 'WORKING'
function assertConsistent(ctx, label = '') {
  const o = openRecords(ctx).length
  if (isWorking(ctx.st.computer.condition)) assert.equal(o, 0, `${label}: computer is Working but ${o} open maintenance record(s) remain`)
  else assert.equal(o, 1, `${label}: computer is ${ctx.st.computer.condition} but open maintenance records = ${o}`)
}

test('control: WITHOUT the computer row lock the same mock reproduces the inconsistency (Working computer left with an open record / non-working with none) for some interleavings', async () => {
  let bad = 0
  for (let k = 0; k <= 10; k++) for (const order of [['DAMAGED', 'WORKING'], ['WORKING', 'DAMAGED']]) {
    const ctx = load({ honourLock: false }); await Promise.all([put(ctx, order[0]), putLater(ctx, order[1], k)])
    try { assertConsistent(ctx) } catch { bad++ }
  }
  assert.ok(bad > 0, 'the race must be reproducible without locks')
})
test('concurrent condition edits (Working->Damaged racing Damaged->Working, every start offset, both orders): maintenance always matches the final committed condition', async () => {
  for (let k = 0; k <= 12; k++) for (const order of [['DAMAGED', 'WORKING'], ['WORKING', 'DAMAGED'], ['DAMAGED', 'UNDER REPAIR'], ['UNDER REPAIR', 'WORKING']]) {
    const ctx = load(); const [a, b] = await Promise.all([put(ctx, order[0]), putLater(ctx, order[1], k)])
    assert.equal(a.code, 200); assert.equal(b.code, 200); assertConsistent(ctx, `k=${k} ${order}`); assert.equal(ctx.st.released, ctx.st.opened)
  }
})
test('six concurrent edits with mixed conditions: consistent end state, at most one open record, history kept (rows are completed, never deleted)', async () => {
  for (let seed = 0; seed < 8; seed++) {
    const ctx = load(); const conds = ['DAMAGED', 'WORKING', 'UNDER REPAIR', 'WORKING', 'MISSING', 'WORKING'].map((c, i) => [c, (i * (seed + 1)) % 7])
    const results = await Promise.all(conds.map(([c, d]) => putLater(ctx, c, d)))
    assert.ok(results.every(r => r.code === 200)); assertConsistent(ctx, 'seed ' + seed)
    assert.ok(ctx.st.maintenance.every(r => OPEN.includes(r.status) || r.status === 'COMPLETED'))
    const created = ctx.audits.filter(a => a[1] === 'MAINTENANCE UPDATE' && /opened automatically/.test(a[2])).length
    assert.equal(ctx.st.maintenance.length, created, 'every history row corresponds to one audited automatic creation')
  }
})
test('same-laboratory path no longer uses a stale condition: the condition is read under the row lock (changed after the pre-check, before the lock)', async () => {
  const ctx = load({ condition: 'WORKING' }); const gc = ctx.db.getConnection; let done = false
  ctx.db.getConnection = cb => { if (!done) { done = true; ctx.st.computer.condition = 'DAMAGED'; ctx.st.maintenance.push({ id: 1, computer_id: 5, reported_by: 2, issue_description: 'x', status: 'PENDING', date_resolved: null }) } gc(cb) }
  const r = await put(ctx, 'WORKING')
  assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'closed', 'stale before (WORKING) would have reported "none" and left the record open'); assertConsistent(ctx)
  assert.equal(ctx.st.maintenance[0].status, 'COMPLETED')
})
test('transfer path + same-laboratory edit racing on one computer: consistent end state and the sync ran inside each transaction before its commit', async () => {
  for (let k = 0; k <= 12; k++) {
    const ctx = load({ lab: 1 }); const [a, b] = await Promise.all([put(ctx, 'DAMAGED', { lab: 2 }), putLater(ctx, 'WORKING', k, { lab: 1 })])
    assert.ok([200, 400, 409].includes(a.code) && [200, 400, 409].includes(b.code), `${a.code}/${b.code}`); assertConsistent(ctx, 'k=' + k); assert.equal(ctx.st.released, ctx.st.opened)
  }
})
test('response and audit are unchanged: created / closed / exists / none outcomes, "MAINTENANCE UPDATE" audit texts, same message, computer echo', async () => {
  const ctx = load(); let r = await put(ctx, 'DAMAGED', { note: 'Cracked screen' })
  assert.equal(r.code, 200); assert.equal(r.body.message, 'Computer updated successfully'); assert.equal(r.body.maintenance.action, 'created'); assert.equal(r.body.computer.condition, 'DAMAGED')
  assert.ok(ctx.audits.some(a => a[1] === 'ASSET UPDATE')); assert.ok(ctx.audits.some(a => a[1] === 'MAINTENANCE UPDATE' && /opened automatically: PC-05 \(A5\) condition changed from Working to DAMAGED/.test(a[2])))
  r = await put(ctx, 'DAMAGED', { note: 'more' }); assert.equal(r.body.maintenance.action, 'none')
  r = await put(ctx, 'WORKING'); assert.equal(r.body.maintenance.action, 'closed'); assert.ok(ctx.audits.some(a => /completed automatically: PC-05 \(A5\) is Working again/.test(a[2])))
  assert.equal(ctx.st.maintenance.length, 1); assert.equal(ctx.st.maintenance[0].status, 'COMPLETED'); assert.equal(ctx.st.committed, 3)
})
test('rollback: computer UPDATE fails (duplicate key) -> 409, nothing changed, no maintenance row, connection released, next edit works', async () => {
  const ctx = load({ updateFail: Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }) })
  let r = await put(ctx, 'DAMAGED'); assert.equal(r.code, 409); assert.match(r.body.message, /Identifiers must be unique/)
  assert.equal(ctx.st.computer.condition, 'WORKING'); assert.equal(ctx.st.maintenance.length, 0); assert.equal(ctx.st.rolledBack, 1); assert.equal(ctx.st.released, ctx.st.opened)
  r = await put(ctx, 'DAMAGED'); assert.equal(r.code, 200); assertConsistent(ctx)
})
test('sync failure (ordinary SQL error): the edit stays saved and is reported as action "error" (existing behaviour), no maintenance change, committed, lock released', async () => {
  const ctx = load({ syncFail: { code: 'ER_X', message: 'boom' } }); const r = await put(ctx, 'DAMAGED')
  assert.equal(r.code, 200); assert.deepEqual(r.body.maintenance, { action: 'error' }); assert.equal(ctx.st.computer.condition, 'DAMAGED'); assert.equal(ctx.st.maintenance.length, 0)
  assert.equal(ctx.st.committed, 1); assert.equal(ctx.st.rolledBack, 0); assert.equal(ctx.st.released, ctx.st.opened)
})
test('sync failure that aborts the transaction (deadlock / lock-wait timeout): the WHOLE edit is rolled back -> 500 "Unable to update computer"; condition and maintenance restored; lock freed', async () => {
  for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']) {
    const ctx = load({ syncFail: { code, once: true } }); const [a, b] = await Promise.all([put(ctx, 'DAMAGED'), putLater(ctx, 'DAMAGED', 3)])
    assert.equal(a.code, 500); assert.equal(a.body.message, 'Unable to update computer'); assert.equal(ctx.st.rolledBack, 1, code)
    assert.equal(b.code, 200, 'the waiting request proceeds once the lock is released'); assertConsistent(ctx, code); assert.equal(ctx.st.released, ctx.st.opened)
    assert.ok(!ctx.audits.some(x => x[1] === 'ASSET UPDATE' && ctx.st.committed === 0))
  }
})
test('commit failure: rolled back (computer condition and maintenance restored), 500, released, no audit entries for the failed edit', async () => {
  const ctx = load({ commitFail: true }); const r = await put(ctx, 'DAMAGED')
  assert.equal(r.code, 500); assert.equal(r.body.message, 'Unable to update computer'); assert.equal(ctx.st.computer.condition, 'WORKING'); assert.equal(ctx.st.maintenance.length, 0)
  assert.equal(ctx.st.rolledBack, 1); assert.equal(ctx.st.released, ctx.st.opened); assert.equal(ctx.audits.length, 0)
})
test('no signed-in user id: sync reports "skipped" inside the transaction, edit still saved (unchanged behaviour)', async () => {
  const ctx = load(); const r = await put(ctx, 'DAMAGED', { user: {} }); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'skipped'); assert.equal(ctx.st.maintenance.length, 0)
})
test('validation / pre-check failures open no transaction (400 validation, 404 laboratory, 404 computer)', async () => {
  const ctx = load(); let r = res(); ctx.controller.updateComputer({ params: { id: '5' }, body: { ...body('DAMAGED'), ram: 'x' } }, r); assert.equal(r.code, 400)
  r = await put(ctx, 'DAMAGED', { lab: 9 }); assert.equal(r.code, 404); assert.equal(r.body.message, 'Laboratory not found')
  r = res(); ctx.controller.updateComputer({ params: { id: '77' }, body: body('DAMAGED', 1, 'n'), user: { id: 2 } }, r); await r.p; assert.equal(r.code, 404); assert.equal(r.body.message, 'Computer not found'); assert.equal(ctx.st.began, 0)
})
