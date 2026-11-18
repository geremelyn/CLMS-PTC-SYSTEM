'use strict'
// CP115 - computer condition <-> Maintenance list. MOCKED database: an in-memory computers + maintenance table that evaluates the same
// predicates the SQL uses (open = PENDING / IN PROGRESS, NOT EXISTS duplicate guard). This is NOT a real MySQL/MariaDB test.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const OPEN = ['PENDING', 'IN PROGRESS']
function env({ condition = 'WORKING', maintenance = [], failMaintenance = false } = {}) {
  const state = { computer: { id: 5, computer_name: 'PC-05', laboratory_id: 1, asset_tag: 'PTC-05', condition, operational_status: 'ACTIVE' }, maintenance: maintenance.map(r => ({ ...r })), sql: [], nextId: 100 }
  const db = { query(sql, values, cb) {
    if (typeof values === 'function') { cb = values; values = [] }
    const n = sql.replace(/\s+/g, ' ').trim(); state.sql.push(n)
    if (n.startsWith('SELECT * FROM laboratories')) return cb(null, [{ id: 1 }])
    if (n.startsWith('SELECT * FROM computers WHERE id')) return cb(null, [{ ...state.computer }])
    if (n.startsWith('SELECT id, laboratory_id, `condition` FROM computers WHERE id = ? FOR UPDATE')) return cb(null, [{ id: 5, laboratory_id: state.computer.laboratory_id, condition: state.computer.condition }])   // CP182: row lock + locked before-condition
    if (n.startsWith('UPDATE computers SET')) { state.computer.condition = values[values.length - 3]; state.computer.condition_note = values[values.length - 2]; return cb(null, { affectedRows: 1 }) }
    if (n.startsWith('INSERT INTO maintenance')) {
      if (failMaintenance) return cb(Object.assign(new Error('boom'), { code: 'ER_X' }))
      const [computerId, userId, description] = values
      if (state.maintenance.some(r => r.computer_id === values[3] && OPEN.includes(r.status))) return cb(null, { affectedRows: 0, insertId: 0 })
      const row = { id: state.nextId++, computer_id: computerId, reported_by: userId, issue_description: description, status: 'PENDING', date_resolved: null, maintenance_note: null }
      state.maintenance.push(row); return cb(null, { affectedRows: 1, insertId: row.id })
    }
    if (n.startsWith("UPDATE maintenance SET status = 'COMPLETED'")) {
      if (failMaintenance) return cb(Object.assign(new Error('boom'), { code: 'ER_X' }))
      let count = 0; for (const r of state.maintenance) if (r.computer_id === values[0] && OPEN.includes(r.status)) { r.status = 'COMPLETED'; r.date_resolved = 'NOW'; r.maintenance_note = r.maintenance_note ?? 'Resolved automatically'; count++ }
      return cb(null, { affectedRows: count })
    }
    cb(new Error('Unexpected SQL: ' + n))
  } }
  // CP178 A2: createComputer now uses a pooled connection + transaction; the mocked connection delegates to the same (possibly re-assigned) db.query.
  db.getConnection = cb => cb(null, { query: (...a) => db.query(...a), beginTransaction: c => c(), commit: c => c(), rollback: c => c(), release() {} })
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) }); stub('../utils/assetIdentifierCheck.js', { checkOtherAssetIdentifiers: (d, t, a, s, cb) => cb(null, false) })
  const cp = path.resolve(__dirname, '../controllers/computerController.js'); delete require.cache[cp]
  return { controller: require(cp), state, audits }
}
const res = () => { let done; const p = new Promise(r => { done = r }); return { code: 200, body: null, p, status(c) { this.code = c; return this }, json(b) { this.body = b; done(this); return this } } }
const body = (condition, note = null) => ({ computer_name: 'PC-05', laboratory_id: 1, asset_tag: 'PTC-05', serial_number: 'SN5', processor: 'i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition, condition_note: note })
const put = (ctx, condition, note, user = { id: 2, role: 'MIS' }) => { const r = res(); ctx.controller.updateComputer({ params: { id: '5' }, body: body(condition, note), user }, r); return r.p }  // CP182: the update is now transactional/async - returns a promise of the response
const open = ctx => ctx.state.maintenance.filter(r => OPEN.includes(r.status))
const touchesMaintenance = ctx => ctx.state.sql.filter(s => /maintenance/i.test(s))

test('Working -> DAMAGED creates exactly one PENDING maintenance record linked to the computer', async () => {
  const ctx = env(); const r = (await put(ctx, 'DAMAGED', 'Cracked screen'))
  assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'created')
  assert.equal(ctx.state.maintenance.length, 1); const m = ctx.state.maintenance[0]
  assert.equal(m.computer_id, 5); assert.equal(m.status, 'PENDING'); assert.equal(m.reported_by, 2)
  assert.match(m.issue_description, /Working to DAMAGED/); assert.match(m.issue_description, /Cracked screen/)
  assert.ok(ctx.audits.some(a => a[1] === 'MAINTENANCE UPDATE' && /opened automatically/.test(a[2])))
})
test('every non-working condition triggers it (UNDER REPAIR, MISSING, RETIRED, custom) and "working" is case-insensitive', async () => {
  for (const c of ['UNDER REPAIR', 'MISSING', 'RETIRED', 'Overheating']) { const ctx = env({ condition: 'working' }); assert.equal((await put(ctx, c, 'note')).body.maintenance.action, 'created', c); assert.equal(open(ctx).length, 1) }
})
test('saving an already non-working computer again (other fields / note) never creates another record', async () => {
  const ctx = env(); (await put(ctx, 'DAMAGED', 'Cracked screen')); const again = (await put(ctx, 'DAMAGED', 'Cracked screen, also keyboard')); const third = (await put(ctx, 'UNDER REPAIR', 'Sent to vendor'))
  assert.equal(again.body.maintenance.action, 'none'); assert.equal(third.body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance.length, 1)
})
test('duplicate guard: an existing open record (PENDING or IN PROGRESS, e.g. a teacher report) is reused, not duplicated', async () => {
  for (const status of ['PENDING', 'IN PROGRESS']) {
    const ctx = env({ maintenance: [{ id: 1, computer_id: 5, reported_by: 9, issue_description: 'No display', status }] })
    const r = (await put(ctx, 'DAMAGED', 'No display')); assert.equal(r.body.maintenance.action, 'exists', status); assert.equal(ctx.state.maintenance.length, 1)
  }
})
test('duplicate guard also holds for a stale / double submit of the same Working -> DAMAGED change', async () => {
  const ctx = env(); (await put(ctx, 'DAMAGED', 'x')); ctx.state.computer.condition = 'WORKING' // second request still saw Working
  assert.equal((await put(ctx, 'DAMAGED', 'x')).body.maintenance.action, 'exists'); assert.equal(ctx.state.maintenance.length, 1)
})
test('DAMAGED -> Working completes the open record(s) and keeps them in history (not deleted)', async () => {
  const ctx = env({ condition: 'DAMAGED', maintenance: [
    { id: 1, computer_id: 5, reported_by: 2, issue_description: 'a', status: 'PENDING' }, { id: 2, computer_id: 5, reported_by: 2, issue_description: 'b', status: 'IN PROGRESS' },
    { id: 3, computer_id: 5, reported_by: 2, issue_description: 'old', status: 'COMPLETED', maintenance_note: 'fixed earlier', date_resolved: '2026-01-01' },
    { id: 4, computer_id: 5, reported_by: 2, issue_description: 'old2', status: 'CLOSED' }, { id: 5, computer_id: 6, reported_by: 2, issue_description: 'other pc', status: 'PENDING' }] })
  const r = (await put(ctx, 'WORKING', null)); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'closed'); assert.equal(r.body.maintenance.count, 2)
  assert.equal(open(ctx).filter(x => x.computer_id === 5).length, 0); assert.equal(ctx.state.maintenance.length, 5)
  assert.deepEqual(ctx.state.maintenance.map(x => x.status), ['COMPLETED', 'COMPLETED', 'COMPLETED', 'CLOSED', 'PENDING'])
  assert.equal(ctx.state.maintenance[2].maintenance_note, 'fixed earlier'); assert.equal(ctx.state.maintenance[2].date_resolved, '2026-01-01') // existing history untouched
  assert.equal(ctx.state.maintenance[4].status, 'PENDING') // another computer's record untouched
  assert.ok(ctx.audits.some(a => /completed automatically/.test(a[2])))
})
test('non-working -> Working with nothing open changes nothing', async () => {
  const ctx = env({ condition: 'DAMAGED', maintenance: [{ id: 3, computer_id: 5, reported_by: 2, issue_description: 'old', status: 'COMPLETED' }] })
  const r = (await put(ctx, 'WORKING', null)); assert.equal(r.body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance.length, 1); assert.equal(ctx.state.maintenance[0].status, 'COMPLETED')
})
test('full cycle Working -> DAMAGED -> Working -> UNDER REPAIR: history kept, one open record at the end', async () => {
  const ctx = env(); (await put(ctx, 'DAMAGED', 'screen')); (await put(ctx, 'WORKING', null)); (await put(ctx, 'UNDER REPAIR', 'power supply'))
  assert.equal(ctx.state.maintenance.length, 2); assert.equal(ctx.state.maintenance[0].status, 'COMPLETED'); assert.equal(ctx.state.maintenance[1].status, 'PENDING'); assert.equal(open(ctx).length, 1)
})
test('Working -> Working (no condition change) never touches the maintenance table', async () => {
  const ctx = env(); const r = (await put(ctx, 'WORKING', null)); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'none'); assert.equal(touchesMaintenance(ctx).length, 0)
})
test('validation unchanged: a non-working condition without a note is rejected (400) and nothing is written', async () => {
  const ctx = env(); const r = (await put(ctx, 'DAMAGED', '')); assert.equal(r.code, 400); assert.equal(ctx.state.maintenance.length, 0); assert.equal(touchesMaintenance(ctx).length, 0)
})
test('the computer edit still succeeds if the maintenance sync fails (reported as action "error", logged)', async () => {
  const ctx = env({ failMaintenance: true }); const r = (await put(ctx, 'DAMAGED', 'x')); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'error'); assert.equal(ctx.state.computer.condition, 'DAMAGED')
})
test('no signed-in user id -> record is skipped (reported_by is NOT NULL), edit still succeeds', async () => {
  const ctx = env(); const r = (await put(ctx, 'DAMAGED', 'x', {})); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'skipped'); assert.equal(ctx.state.maintenance.length, 0)
})
test('SQL uses the same open statuses as the Maintenance page and needs no schema change', () => {
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '../utils/computerMaintenanceSync.js'), 'utf8')
  assert.match(src, /IN \$\{OPEN_STATUSES\}/); assert.match(src, /\('PENDING','IN PROGRESS'\)/); assert.doesNotMatch(src, /ALTER TABLE|CREATE TABLE/i)
  const route = require('node:fs').readFileSync(path.resolve(__dirname, '../routes/computerRoutes.js'), 'utf8'); assert.match(route, /router\.put\('\/:id', requireRole\('MIS','Inventory Staff'\), updateComputer\)/)
})

// CP135 - creating a computer as Not Working / custom opens exactly one open record; Working opens none. (Mocked DB, as above.)
test('CP135 create: Not Working opens one record, Working opens none', async () => {
  for (const [cond, expected] of [['NOT WORKING', 1], ['Overheating', 1], ['WORKING', 0]]) {
    const ctx = env()
    const origQuery = null
    const state = ctx.state
    const dbp = require(path.resolve(__dirname, '../database/db.js'))
    const base = dbp.query
    dbp.query = (sql, values, cb) => {
      if (typeof values === 'function') { cb = values; values = [] }
      const n = sql.replace(/\s+/g, ' ').trim()
      if (/^SELECT \*\s?FROM laboratories/.test(n)) return cb(null, [{ id: 1, capacity: 50 }])
      if (n.startsWith('SELECT COUNT')) return cb(null, [{ registeredComputers: 0 }])
      if (n.startsWith('INSERT INTO computers')) return cb(null, { insertId: 5, affectedRows: 1 })
      return base(sql, values, cb)
    }
    const r = res(); ctx.controller.createComputer({ body: body(cond, cond === 'WORKING' ? null : 'note'), user: { id: 2, role: 'MIS' } }, r)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(open(ctx).length, expected)
    void origQuery; void state
  }
})
