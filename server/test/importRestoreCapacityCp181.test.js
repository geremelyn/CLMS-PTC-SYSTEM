'use strict'
// CP181 - MOCKED database (NOT real MySQL/MariaDB). One shared in-memory store serves computerController (create + transfer), the Excel import commit and the
// Recycle Bin restore. Connections emulate: InnoDB row locks for "... FOR UPDATE" on laboratories (waiters queue until commit/rollback/release), buffered writes
// that become visible only on commit, and REPEATABLE READ snapshots (the first NON-locking read of a computers table fixes what later plain reads see).
// Async gaps between read and write make lost-update races reproducible (see the control test).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const tick = () => new Promise(resolve => setImmediate(resolve))
const CAP_COLS = ['id', 'computer_name', 'laboratory_id', 'asset_tag', 'serial_number', 'processor', 'ram', 'storage_capacity', 'storage_unit', 'storage_type', 'operational_status', 'condition', 'condition_note']
function load({ labs = { 1: 3 }, computers = [], bin = [], honourLock = true, failInsertAt = null } = {}) {
  const st = { labs: { ...labs }, computers: computers.map(c => ({ ...c })), bin: bin.map(b => ({ ...b })), began: 0, committed: 0, rolledBack: 0, released: 0, opened: 0, lockOrder: [], sql: [], nextId: 900, inserts: 0 }
  const locks = new Map()
  const acquire = (key, owner) => new Promise(resolve => { const q = locks.get(key) || { holder: null, waiters: [] }; locks.set(key, q); if (!q.holder || q.holder === owner) { q.holder = owner; return resolve() } q.waiters.push(() => { q.holder = owner; resolve() }) })
  const releaseAll = owner => { for (const q of locks.values()) if (q.holder === owner) { q.holder = null; const w = q.waiters.shift(); if (w) w() } }
  const mkConn = (counted = true) => {
    const owner = Symbol('c'); if (counted) st.opened++
    let snapshot = null, pending = [], pendingBin = [], txn = false
    const visible = () => (snapshot || st.computers).concat(pending)
    const snap = () => { if (!snapshot) snapshot = st.computers.map(c => ({ ...c })) }
    const conn = {
      beginTransaction(cb) { st.began++; txn = true; cb() },
      commit(cb) { st.committed++; st.computers.push(...pending); for (const [id, v] of pendingBin) { const b = st.bin.find(x => x.id === id); if (b) b.restored_at = v } pending = []; pendingBin = []; releaseAll(owner); cb() },
      rollback(cb) { st.rolledBack++; pending = []; pendingBin = []; releaseAll(owner); cb() },
      release() { st.released++; releaseAll(owner) },
      query(sql, values, cb) {
        if (typeof values === 'function') { cb = values; values = [] }
        const n = sql.replace(/\s+/g, ' ').trim(); st.sql.push(n)
        ;(async () => {
          try {
            const labRow = id => st.labs[id] != null ? { id: Number(id), capacity: st.labs[id] } : null
            const lockLab = async id => { if (honourLock) await acquire('lab' + id, owner); st.lockOrder.push([owner, Number(id)]); await tick() }
            // ---- laboratory locking reads (all three controllers use one of these two forms) ----
            let m
            if (/^SELECT \* FROM laboratories WHERE id=\? FOR UPDATE$/.test(n) || /^SELECT id, capacity FROM laboratories WHERE id = \? FOR UPDATE$/.test(n) || /^SELECT id FROM laboratories WHERE id = \? FOR UPDATE$/.test(n)) { await lockLab(values[0]); const r = labRow(values[0]); return cb(null, r ? [r] : []) }
            if (/^SELECT \* FROM laboratories WHERE ID =\?/.test(n)) { await tick(); const r = labRow(values[0]); return cb(null, r ? [r] : []) }
            if (/^SELECT id FROM laboratories WHERE id = \? LIMIT 1$/.test(n)) { await tick(); const r = labRow(values[0]); return cb(null, r ? [{ id: r.id }] : []) }
            if (/^SELECT capacity FROM laboratories WHERE id = \?$/.test(n)) { await tick(); const r = labRow(values[0]); return cb(null, r ? [{ capacity: r.capacity }] : []) }
            if (/^SELECT id, laboratory_name, capacity FROM laboratories$/.test(n)) { await tick(); return cb(null, Object.keys(st.labs).map(id => ({ id: Number(id), laboratory_name: 'Lab ' + id, capacity: st.labs[id] }))) }
            // ---- computers: plain (snapshot) reads ----
            if (/^SELECT COUNT\(\*\) AS registeredComputers FROM computers WHERE laboratory_id = ?\?/.test(n)) { snap(); await tick(); await tick(); const lab = Number(values[0]), skip = /id <> \?/.test(n) ? values[1] : null; return cb(null, [{ registeredComputers: visible().filter(c => Number(c.laboratory_id) === lab && c.id !== skip).length }]) }
            if (/^SELECT id, computer_name, laboratory_id FROM computers$/.test(n)) { snap(); await tick(); return cb(null, visible().map(c => ({ id: c.id, computer_name: c.computer_name, laboratory_id: c.laboratory_id }))) }
            if (/^SELECT id, LOWER\(computer_name\)/.test(n)) { snap(); await tick(); return cb(null, visible().filter(c => c.laboratory_id === values[0]).map(c => ({ id: c.id, lname: String(c.computer_name).toLowerCase() }))) }
            if (/^SELECT asset_tag, serial_number FROM computers FOR UPDATE$/.test(n)) { await tick(); return cb(null, st.computers.concat(pending).map(c => ({ asset_tag: c.asset_tag, serial_number: c.serial_number }))) }
            if (/^SELECT asset_tag, serial_number FROM equipment FOR UPDATE$/.test(n)) return cb(null, [])
            if (/^SELECT category, value FROM lookup_options$/.test(n)) return cb(null, [{ category: 'computer_storage_unit', value: 'GB' }, { category: 'computer_storage_type', value: 'SSD' }, { category: 'computer_status', value: 'ACTIVE' }, { category: 'computer_condition', value: 'WORKING' }])
            if (/^SELECT id FROM (equipment|computers) WHERE \(asset_tag IS NOT NULL/.test(n)) return cb(null, [])
            if (/^SELECT id FROM computers WHERE id = \? LIMIT 1$/.test(n)) { snap(); await tick(); return cb(null, visible().filter(c => c.id === values[0]).map(c => ({ id: c.id }))) }
            if ((m = /^SELECT id FROM (computers|equipment) WHERE `(asset_tag|serial_number)` = \? LIMIT 1$/.exec(n))) { snap(); await tick(); return cb(null, m[1] === 'computers' ? visible().filter(c => c[m[2]] === values[0]).map(c => ({ id: c.id })) : []) }
            if (/^SELECT \* FROM computers WHERE id =\?/.test(n)) { await tick(); return cb(null, st.computers.filter(c => c.id === values[0]).map(c => ({ ...c }))) }
            if (/^SELECT id, laboratory_id, `condition` FROM computers WHERE id = \? FOR UPDATE$/.test(n)) { await tick(); return cb(null, st.computers.filter(c => c.id === values[0]).map(c => ({ id: c.id, laboratory_id: c.laboratory_id, condition: c.condition }))) }
            // ---- inserts / updates ----
            if ((m = /^INSERT INTO computers ?\(([^)]*)\) ?(VALUES|SELECT)/.exec(n))) {
              st.inserts++; if (failInsertAt === st.inserts) return cb(Object.assign(new Error('simulated insert failure'), { code: 'ER_BAD_FIELD_ERROR' }))
              const cols = m[1].split(',').map(x => x.replace(/[`\s]/g, '')); const row = {}; cols.forEach((c, i) => { row[c] = values[i] }); if (row.id == null) row.id = st.nextId++
              await tick(); pending.push(row); return cb(null, { affectedRows: 1, insertId: row.id })
            }
            if (/^UPDATE computers SET/.test(n)) { await tick(); const id = values[values.length - 1], row = st.computers.find(c => c.id === id); if (!row) return cb(null, { affectedRows: 0 }); row.computer_name = values[0]; row.laboratory_id = values[1]; return cb(null, { affectedRows: 1 }) }
            // ---- recycle bin ----
            if (/^SELECT id, snapshot_json FROM recycle_bin WHERE entity_type = 'computers' AND restored_at IS NULL AND id IN/.test(n)) { await tick(); return cb(null, st.bin.filter(b => b.entity_type === 'computers' && !b.restored_at && values.includes(b.id)).sort((a, b) => a.id - b.id).map(b => ({ id: b.id, snapshot_json: b.snapshot_json }))) }
            if (/^SELECT \* FROM recycle_bin WHERE id = \? FOR UPDATE$/.test(n)) { await tick(); if (honourLock) await acquire('bin' + values[0], owner); return cb(null, st.bin.filter(b => b.id === values[0]).map(b => ({ ...b }))) }
            if (/^UPDATE recycle_bin SET restored_at = NOW\(\)/.test(n)) { pendingBin.push([values[1], 'now']); return cb(null, { affectedRows: 1 }) }
            cb(new Error('unexpected SQL: ' + n))
          } catch (e) { cb(e) }
        })()
      }
    }
    void txn; return conn
  }
  const db = { query(sql, values, cb) { return mkConn(false).query(sql, values, cb) }, getConnection(cb) { cb(null, mkConn()) } }
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const mod = new Module(p); mod.filename = p; mod.loaded = true; mod.exports = exports; require.cache[p] = mod }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) })
  stub('../utils/assetIdentifierCheck.js', { checkOtherAssetIdentifiers: (d, t, a, s, cb) => cb(null, false) })
  stub('../utils/computerMaintenanceSync.js', { syncComputerMaintenance: (d, o, cb) => cb(null, { action: 'none' }) })
  for (const f of ['controllers/computerController.js', 'controllers/excelImportController.js', 'controllers/recycleBinController.js', 'controllers/bulkRecordController.js']) delete require.cache[path.resolve(__dirname, '../' + f)]
  const computer = require('../controllers/computerController.js'), imp = require('../controllers/excelImportController.js').createExcelImportController('computers'), eqImp = require('../controllers/excelImportController.js').createExcelImportController('equipment'), recycle = require('../controllers/recycleBinController.js')
  return { st, computer, imp, eqImp, recycle, audits }
}
const res = () => { let done; const p = new Promise(r => { done = r }); return { code: 200, body: null, p, status(c) { this.code = c; return this }, json(b) { this.body = b; done(this); return this } } }
const user = { id: 1, role: 'MIS' }
const create = (ctx, n, lab = 1) => { const r = res(); ctx.computer.createComputer({ body: { computer_name: 'C' + n, laboratory_id: lab, asset_tag: 'CT-' + n, serial_number: 'CS-' + n, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' }, user }, r); return r.p }
const importRows = (ctx, tag, count, lab = 1) => { const r = res(); ctx.imp.commit({ body: { rows: Array.from({ length: count }, (_, i) => ({ rowNumber: i + 2, data: { computer_name: `${tag}-${i}`, laboratory_id: lab, asset_tag: `IA-${tag}-${i}`, serial_number: `IS-${tag}-${i}`, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' } })) }, user }, r); return r.p }
const snapshotOf = (id, lab) => JSON.stringify({ id, computer_name: 'R' + id, laboratory_id: lab, asset_tag: 'RT-' + id, serial_number: 'RS-' + id, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING', condition_note: null })
const binRow = (binId, compId, lab) => ({ id: binId, entity_type: 'computers', entity_id: compId, label: 'R' + compId, snapshot_json: snapshotOf(compId, lab), restored_at: null })
const restore = (ctx, id) => { const r = res(); ctx.recycle.restoreRecycleItem({ params: { id: String(id) }, user }, r); return r.p }
const restoreMany = (ctx, ids) => { const r = res(); ctx.recycle.restoreRecycleItems({ body: { ids }, user }, r); return r.p }
const inLab = (ctx, lab) => ctx.st.computers.filter(c => Number(c.laboratory_id) === lab).length
const ok = r => r.code === 200 || r.code === 201

test('control: WITHOUT laboratory locks the same mock lets concurrent create + import + restore exceed capacity (proves the test can detect the race)', async () => {
  const ctx = load({ labs: { 1: 3 }, honourLock: false, bin: [binRow(1, 501, 1), binRow(2, 502, 1)] })
  await Promise.all([create(ctx, 1), create(ctx, 2), importRows(ctx, 'A', 2), restore(ctx, 1), restore(ctx, 2)])
  assert.ok(inLab(ctx, 1) > 3, 'race should be reproducible without locks: ' + inLab(ctx, 1))
})
test('create + transfer + import + restore racing for ONE lab (capacity 3): never above capacity, and every refusal is a clean 400/409', async () => {
  const ctx = load({ labs: { 1: 3, 2: 9 }, computers: [{ id: 40, computer_name: 'X', laboratory_id: 2, asset_tag: 'XT', serial_number: 'XS' }], bin: [binRow(1, 501, 1), binRow(2, 502, 1)] })
  const tr = res(); ctx.computer.updateComputer({ params: { id: '40' }, body: { computer_name: 'X', laboratory_id: 1, asset_tag: 'XT', serial_number: 'XS', processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' }, user }, tr)
  const results = await Promise.all([create(ctx, 1), create(ctx, 2), importRows(ctx, 'A', 2), restore(ctx, 1), restore(ctx, 2), tr.p])
  assert.ok(inLab(ctx, 1) <= 3, 'capacity exceeded: ' + inLab(ctx, 1))
  assert.ok(results.every(r => ok(r) || r.code === 400 || r.code === 409), JSON.stringify(results.map(r => [r.code, r.body && r.body.message])))
  assert.ok(results.filter(ok).length >= 1); assert.equal(ctx.st.released, ctx.st.opened)
})
test('two concurrent Excel imports of 2 rows into a lab with 3 free places: exactly one is committed, the other is refused as a whole (409, nothing saved)', async () => {
  const ctx = load({ labs: { 1: 3 } })
  const [a, b] = await Promise.all([importRows(ctx, 'A', 2), importRows(ctx, 'B', 2)])
  assert.deepEqual([a.code, b.code].sort(), [201, 409]); assert.equal(inLab(ctx, 1), 2)
  const refused = [a, b].find(r => r.code === 409); assert.match(JSON.stringify(refused.body), /Laboratory reached its limit/); assert.match(refused.body.message, /No rows were saved/)
})
test('an Excel import racing a create for the same last places: total never exceeds capacity (import 2 rows + 2 creates into capacity 3)', async () => {
  const ctx = load({ labs: { 1: 3 } })
  const results = await Promise.all([importRows(ctx, 'A', 2), create(ctx, 1), create(ctx, 2)])
  assert.ok(inLab(ctx, 1) <= 3); assert.equal(results.filter(ok).length >= 1, true)
})
test('Excel import: laboratory rows are locked FOR UPDATE in ascending id order BEFORE any non-locking read; equipment imports take no laboratory lock', async () => {
  const ctx = load({ labs: { 1: 9, 2: 9, 3: 9 } })
  const rows = [3, 1, 2, 3].map((lab, i) => ({ rowNumber: i + 2, data: { computer_name: 'N' + i, laboratory_id: lab, asset_tag: 'T' + i, serial_number: 'S' + i, processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING' } }))
  const r = res(); ctx.imp.commit({ body: { rows }, user }, r); await r.p
  assert.equal(r.code, 201, JSON.stringify(r.body)); assert.deepEqual(ctx.st.lockOrder.map(x => x[1]), [1, 2, 3])
  const firstLock = ctx.st.sql.findIndex(s => /FOR UPDATE$/.test(s) && /laboratories/.test(s)), firstPlain = ctx.st.sql.findIndex(s => s === 'SELECT id, laboratory_name, capacity FROM laboratories')
  assert.ok(firstLock >= 0 && firstLock < firstPlain, ctx.st.sql.slice(0, 6).join(' | '))
  const ctx2 = load({ labs: { 1: 9 } }); const e = res(); ctx2.eqImp.commit({ body: { rows: [] }, user }, e); await e.p; assert.equal(e.code, 400); assert.equal(ctx2.st.lockOrder.length, 0)
})
test('Excel import failure paths: insert failure -> 500, rolled back, released, laboratory lock freed (next import proceeds); validation failure -> 409 rolled back', async () => {
  const ctx = load({ labs: { 1: 5 }, failInsertAt: 2 })
  const [a, b] = await Promise.all([importRows(ctx, 'A', 3), importRows(ctx, 'B', 1)])
  const failed = [a, b].find(r => r.code === 500); assert.ok(failed); assert.match(failed.body.message, /rolled back/); assert.ok(ctx.st.rolledBack >= 1)
  assert.equal(ctx.st.released, ctx.st.opened); assert.equal(ctx.st.computers.filter(c => /^IA-A/.test(c.asset_tag)).length === 0 || ctx.st.computers.filter(c => /^IA-A/.test(c.asset_tag)).length === 3, true)
  const full = load({ labs: { 1: 1 } }); const x = await importRows(full, 'A', 2); assert.equal(x.code, 409); assert.equal(full.st.rolledBack, 1); assert.equal(full.st.released, full.st.opened); assert.equal(inLab(full, 1), 0)
})
test('Recycle Bin restore of a computer into a FULL laboratory is refused (409), rolled back, and the item stays in the Recycle Bin', async () => {
  const ctx = load({ labs: { 1: 2 }, computers: [{ id: 1, computer_name: 'A', laboratory_id: 1, asset_tag: 'a', serial_number: 'a' }, { id: 2, computer_name: 'B', laboratory_id: 1, asset_tag: 'b', serial_number: 'b' }], bin: [binRow(1, 501, 1)] })
  const r = await restore(ctx, 1)
  assert.equal(r.code, 409); assert.match(r.body.message, /reached its limit/); assert.match(r.body.message, /stays in the Recycle Bin/)
  assert.equal(ctx.st.rolledBack, 1); assert.equal(ctx.st.committed, 0); assert.equal(inLab(ctx, 1), 2); assert.equal(ctx.st.bin[0].restored_at, null); assert.equal(ctx.st.released, ctx.st.opened)
})
test('Recycle Bin restore with room still works: 200, computer re-inserted, item marked restored, committed', async () => {
  const ctx = load({ labs: { 1: 2 }, computers: [{ id: 1, computer_name: 'A', laboratory_id: 1, asset_tag: 'a', serial_number: 'a' }], bin: [binRow(1, 501, 1)] })
  const r = await restore(ctx, 1); assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(inLab(ctx, 1), 2); assert.equal(ctx.st.committed, 1); assert.equal(ctx.st.bin[0].restored_at, 'now')
})
test('batch restore is all-or-nothing and counts its own earlier restores: 3 computers into a lab with 2 free places -> 409, nothing restored', async () => {
  const ctx = load({ labs: { 1: 3 }, computers: [{ id: 1, computer_name: 'A', laboratory_id: 1, asset_tag: 'a', serial_number: 'a' }], bin: [binRow(1, 501, 1), binRow(2, 502, 1), binRow(3, 503, 1)] })
  const r = await restoreMany(ctx, [1, 2, 3]); assert.equal(r.code, 409); assert.match(r.body.message, /reached its limit/); assert.match(r.body.message, /Nothing was restored/)
  assert.equal(inLab(ctx, 1), 1); assert.ok(ctx.st.bin.every(b => !b.restored_at)); assert.equal(ctx.st.rolledBack, 1)
  const ok2 = await restoreMany(ctx, [1, 2]); assert.equal(ok2.code, 200); assert.equal(inLab(ctx, 1), 3)
})
test('restore: laboratories of the restored computers are locked ascending (lab 1 before lab 3) regardless of recycle-bin id order; concurrent opposite batches do not deadlock', async () => {
  const ctx = load({ labs: { 1: 9, 3: 9 }, bin: [binRow(1, 501, 3), binRow(2, 502, 1), binRow(3, 503, 3), binRow(4, 504, 1)] })
  const [a, b] = await Promise.all([restoreMany(ctx, [1, 2]), restoreMany(ctx, [3, 4])])
  assert.equal(a.code, 200); assert.equal(b.code, 200)
  const per = new Map(); for (const [o, lab] of ctx.st.lockOrder) per.set(o, [...(per.get(o) || []), lab])
  for (const labsLocked of per.values()) assert.deepEqual(labsLocked, [1, 3])
})
test('restore races: two restores + a create for the last 2 places of a lab -> never above capacity, items refused stay in the bin', async () => {
  const ctx = load({ labs: { 1: 2 }, bin: [binRow(1, 501, 1), binRow(2, 502, 1)] })
  const results = await Promise.all([restore(ctx, 1), restore(ctx, 2), create(ctx, 1)])
  assert.equal(inLab(ctx, 1), 2); assert.equal(results.filter(ok).length, 2)
  const refused = results.find(r => !ok(r)); assert.ok(refused.code === 409 || refused.code === 400)
  assert.equal(ctx.st.bin.filter(b => b.restored_at).length + ctx.st.computers.filter(c => /^CT-/.test(c.asset_tag)).length, 2)
})
test('non-computer / unchanged paths: restoring a record whose snapshot has no laboratory capacity problem keeps the original messages (lab gone -> 409 "no longer exists")', async () => {
  const ctx = load({ labs: {}, bin: [binRow(1, 501, 7)] })
  const r = await restore(ctx, 1); assert.equal(r.code, 409); assert.match(r.body.message, /laboratory this record belonged to no longer exists/); assert.equal(ctx.st.rolledBack, 1)
})
