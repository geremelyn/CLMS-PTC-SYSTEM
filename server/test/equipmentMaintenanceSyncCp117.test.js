'use strict'
// CP117 - equipment status <-> Maintenance list.
// TEST TYPES: (A) the real equipmentController against a MOCKED in-memory database that evaluates the same predicates the SQL uses (open = PENDING / IN PROGRESS,
// NOT EXISTS duplicate guard). (B) the real sync SQL run on SQLite with FROM DUAL / NOW() translated. Neither is a real MySQL/MariaDB test.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const OPEN = ['PENDING', 'IN PROGRESS']

function env({ status = 'WORKING', maintenance = [], failMaintenance = false } = {}) {
  const state = { equipment: { id: 9, equipment_type: 'PROJECTOR', laboratory_id: 1, asset_tag: 'EQ-9', status }, maintenance: maintenance.map(r => ({ ...r })), sql: [], nextId: 100 }
  const db = { query(sql, values, cb) {
    if (typeof values === 'function') { cb = values; values = [] }
    const n = sql.replace(/\s+/g, ' ').trim(); state.sql.push(n)
    if (/^SELECT \*\s*FROM laboratories/i.test(n)) return cb(null, [{ id: 1 }])
    if (/^SELECT \*\s*FROM equipment WHERE/i.test(n)) return cb(null, [{ ...state.equipment }])
    if (n === 'SELECT status FROM equipment WHERE id = ?') return cb(null, state.equipment ? [{ status: state.equipment.status }] : [])
    if (n.startsWith('UPDATE equipment SET')) { state.equipment.status = values[values.length - 3]; return cb(null, { affectedRows: 1 }) }
    if (n.startsWith('INSERT INTO equipment')) { state.equipment = { id: 77, status: values[7] }; return cb(null, { insertId: 77 }) }
    if (n.startsWith('INSERT INTO maintenance')) {
      if (failMaintenance) return cb(Object.assign(new Error('boom'), { code: 'ER_X' }))
      const [equipmentId, userId, description] = values
      if (state.maintenance.some(r => r.equipment_id === values[3] && OPEN.includes(r.status))) return cb(null, { affectedRows: 0, insertId: 0 })
      const row = { id: state.nextId++, equipment_id: equipmentId, computer_id: null, reported_by: userId, issue_description: description, status: 'PENDING', date_resolved: null, maintenance_note: null }
      state.maintenance.push(row); return cb(null, { affectedRows: 1, insertId: row.id })
    }
    if (n.startsWith("UPDATE maintenance SET status = 'COMPLETED'")) {
      if (failMaintenance) return cb(Object.assign(new Error('boom'), { code: 'ER_X' }))
      let count = 0; for (const r of state.maintenance) if (r.equipment_id === values[0] && OPEN.includes(r.status)) { r.status = 'COMPLETED'; r.date_resolved = 'NOW'; r.maintenance_note = r.maintenance_note ?? 'Resolved automatically'; count++ }
      return cb(null, { affectedRows: count })
    }
    cb(new Error('Unexpected SQL: ' + n))
  } }
  const stub = (file, exports) => { const p = path.resolve(__dirname, file); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
  const audits = []
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit: (...a) => audits.push(a) }); stub('../utils/assetIdentifierCheck.js', { checkOtherAssetIdentifiers: (d, t, a, s, cb) => cb(null, false) })
  const cp = path.resolve(__dirname, '../controllers/equipmentController.js'); delete require.cache[cp]
  return { controller: require(cp), state, audits }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const body = (status, note = null) => ({ equipment_type: 'PROJECTOR', laboratory_id: 1, computer_id: null, asset_tag: 'EQ-9', serial_number: 'SN9', brand: 'Epson', model: 'X', status, condition_note: note })
const MIS = { id: 2, role: 'MIS' }
const put = (ctx, status, note, user = MIS) => { const r = res(); ctx.controller.updateEquipment({ params: { id: '9' }, body: body(status, note), user }, r); return r }
const create = (ctx, status, note, user = MIS) => { const r = res(); ctx.controller.createEquipment({ body: body(status, note), user }, r); return r }
const open = ctx => ctx.state.maintenance.filter(r => OPEN.includes(r.status))
const touchesMaintenance = ctx => ctx.state.sql.filter(s => /maintenance/i.test(s))
const maintenanceAudits = ctx => ctx.audits.filter(a => a[1] === 'MAINTENANCE UPDATE')

test('Working -> Damaged / Under Repair / Missing each opens exactly ONE PENDING maintenance record linked to the equipment, with an audit entry', () => {
  for (const status of ['DAMAGED', 'UNDER REPAIR', 'MISSING']) {
    const ctx = env(); const r = put(ctx, status, 'Reported by teacher')
    assert.equal(r.code, 200, status); assert.equal(r.body.maintenance.action, 'created', status)
    assert.equal(ctx.state.maintenance.length, 1); const rec = ctx.state.maintenance[0]
    assert.equal(rec.equipment_id, 9); assert.equal(rec.computer_id, null); assert.equal(rec.status, 'PENDING'); assert.equal(rec.reported_by, 2)
    assert.match(rec.issue_description, new RegExp(`Equipment status changed from WORKING to ${status}: Reported by teacher`))
    assert.equal(maintenanceAudits(ctx).length, 1); assert.match(maintenanceAudits(ctx)[0][2], /opened automatically/); assert.equal(maintenanceAudits(ctx)[0][0], 2)
  }
})
test('Active -> non-working also opens a record; lowercase / padded status text is treated the same', () => {
  assert.equal(put(env({ status: 'ACTIVE' }), 'DAMAGED', 'x').body.maintenance.action, 'created')
  const ctx = env({ status: 'working' }); assert.equal(put(ctx, ' damaged ', 'x').body.maintenance.action, 'created'); assert.equal(open(ctx).length, 1)
})
test('Working / Active equipment never appears in Maintenance: Working<->Active and re-saving Working create nothing and run no maintenance SQL', () => {
  const ctx = env({ status: 'WORKING' })
  for (const s of ['ACTIVE', 'WORKING', 'WORKING', 'ACTIVE']) assert.equal(put(ctx, s).body.maintenance.action, 'none')
  assert.equal(ctx.state.maintenance.length, 0); assert.equal(touchesMaintenance(ctx).length, 0)
})
test('saving other fields of an already non-working item (same status) does NOT create repeated entries and does not touch maintenance', () => {
  const ctx = env({ status: 'DAMAGED' })
  for (let i = 0; i < 3; i++) assert.equal(put(ctx, 'DAMAGED', 'same note').body.maintenance.action, 'none')
  assert.equal(ctx.state.maintenance.length, 0); assert.equal(touchesMaintenance(ctx).length, 0)
})
test('an existing OPEN record is reused: Damaged -> Missing / custom with a PENDING or IN PROGRESS record creates no duplicate', () => {
  for (const openStatus of OPEN) {
    const ctx = env({ status: 'DAMAGED', maintenance: [{ id: 1, equipment_id: 9, status: openStatus, issue_description: 'earlier' }] })
    assert.equal(put(ctx, 'MISSING', 'Not found').body.maintenance.action, 'exists'); assert.equal(put(ctx, 'LOST IN TRANSIT', 'Courier').body.maintenance.action, 'exists')
    assert.equal(ctx.state.maintenance.length, 1); assert.equal(ctx.state.maintenance[0].status, openStatus); assert.equal(maintenanceAudits(ctx).length, 0)
  }
})
test('a records of ANOTHER equipment never blocks or is touched; a COMPLETED record does not count as open (a new record is opened)', () => {
  const ctx = env({ status: 'WORKING', maintenance: [{ id: 1, equipment_id: 55, status: 'PENDING' }, { id: 2, equipment_id: 9, status: 'COMPLETED', date_resolved: 'old' }, { id: 3, equipment_id: 9, status: 'CLOSED' }, { id: 4, computer_id: 9, equipment_id: null, status: 'PENDING' }] })
  assert.equal(put(ctx, 'DAMAGED', 'again').body.maintenance.action, 'created'); assert.equal(ctx.state.maintenance.length, 5)
  assert.equal(ctx.state.maintenance[0].status, 'PENDING'); assert.equal(ctx.state.maintenance[3].status, 'PENDING', 'a COMPUTER record with the same number is untouched')
})
test('back to Working or Active completes the open records (date_resolved set) and KEEPS them: Maintenance History is preserved', () => {
  for (const back of ['WORKING', 'ACTIVE']) {
    const ctx = env({ status: 'DAMAGED', maintenance: [{ id: 1, equipment_id: 9, status: 'PENDING', issue_description: 'a', maintenance_note: null }, { id: 2, equipment_id: 9, status: 'IN PROGRESS', issue_description: 'b', maintenance_note: 'tech note' }, { id: 3, equipment_id: 9, status: 'COMPLETED', issue_description: 'old', date_resolved: 'earlier' }] })
    const r = put(ctx, back); assert.equal(r.body.maintenance.action, 'closed'); assert.equal(r.body.maintenance.count, 2)
    assert.equal(ctx.state.maintenance.length, 3, 'no record deleted'); assert.deepEqual(ctx.state.maintenance.map(x => x.status), ['COMPLETED', 'COMPLETED', 'COMPLETED'])
    assert.equal(ctx.state.maintenance[1].maintenance_note, 'tech note', "an existing technician note is not overwritten"); assert.equal(ctx.state.maintenance[2].date_resolved, 'earlier')
    assert.equal(open(ctx).length, 0); assert.match(maintenanceAudits(ctx)[0][2], /2 open maintenance record\(s\) completed automatically/)
  }
})
test('full cycle keeps history: Working -> Damaged -> Working -> Damaged gives two records (first COMPLETED, second PENDING), never a duplicate open one', () => {
  const ctx = env(); put(ctx, 'DAMAGED', 'one'); put(ctx, 'WORKING'); put(ctx, 'DAMAGED', 'two'); put(ctx, 'DAMAGED', 'two')
  assert.deepEqual(ctx.state.maintenance.map(r => r.status), ['COMPLETED', 'PENDING']); assert.equal(open(ctx).length, 1)
})
test('Returning to Working when nothing is open does nothing', () => { const ctx = env({ status: 'DAMAGED' }); assert.equal(put(ctx, 'WORKING').body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance.length, 0) })
test('INACTIVE keeps its meaning (administrative, not damaged): Working/Active -> Inactive opens nothing; Inactive -> Working/Active opens nothing', () => {
  for (const [from, to] of [['WORKING', 'INACTIVE'], ['ACTIVE', 'INACTIVE'], ['INACTIVE', 'WORKING'], ['INACTIVE', 'ACTIVE']]) { const ctx = env({ status: from }); assert.equal(put(ctx, to).body.maintenance.action, 'none', `${from}->${to}`); assert.equal(ctx.state.maintenance.length, 0) }
})
test('Damaged -> Inactive leaves the open record exactly as it is (neither closed nor duplicated); Inactive -> Damaged opens a record', () => {
  const ctx = env({ status: 'DAMAGED', maintenance: [{ id: 1, equipment_id: 9, status: 'PENDING' }] })
  assert.equal(put(ctx, 'INACTIVE').body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance[0].status, 'PENDING')
  assert.equal(put(ctx, 'WORKING').body.maintenance.action, 'closed', 'Damaged -> Inactive -> Working still completes the record that was left open'); assert.equal(ctx.state.maintenance[0].status, 'COMPLETED')
  const ctx2 = env({ status: 'INACTIVE' }); assert.equal(put(ctx2, 'DAMAGED', 'Found broken').body.maintenance.action, 'created'); assert.match(ctx2.state.maintenance[0].issue_description, /changed from INACTIVE to DAMAGED/)
})
test('RETIRED is end-of-life, not a repair need: no record opened, open records untouched', () => {
  const ctx = env({ status: 'DAMAGED', maintenance: [{ id: 1, equipment_id: 9, status: 'IN PROGRESS' }] }); assert.equal(put(ctx, 'RETIRED', 'Old').body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance[0].status, 'IN PROGRESS')
  assert.equal(put(env({ status: 'WORKING' }), 'RETIRED', 'Old').body.maintenance.action, 'none')
})
test('custom ("Others") statuses are non-working: they open a record; a custom status still needs its condition note (400, nothing changes)', () => {
  const ctx = env({ status: 'WORKING' }); const r = put(ctx, 'AWAITING PARTS', 'Waiting for supplier'); assert.equal(r.body.maintenance.action, 'created'); assert.match(ctx.state.maintenance[0].issue_description, /to AWAITING PARTS: Waiting for supplier/)
  const rejected = env({ status: 'WORKING' }); const bad = put(rejected, 'AWAITING PARTS', ''); assert.equal(bad.code, 400); assert.equal(rejected.state.maintenance.length, 0); assert.equal(rejected.state.equipment.status, 'WORKING'); assert.equal(touchesMaintenance(rejected).length, 0)
  const back = env({ status: 'AWAITING PARTS', maintenance: [{ id: 1, equipment_id: 9, status: 'PENDING' }] }); assert.equal(put(back, 'WORKING').body.maintenance.action, 'closed')
})
test('newly registered equipment: non-working status opens a record ("registered with status"), Working / Active / Inactive / Retired do not', () => {
  const damaged = env(); const r = create(damaged, 'DAMAGED', 'Arrived broken'); assert.equal(r.code, 201); assert.equal(r.body.maintenance.action, 'created')
  assert.equal(damaged.state.maintenance[0].equipment_id, 77); assert.match(damaged.state.maintenance[0].issue_description, /^Equipment registered with status DAMAGED: Arrived broken/)
  for (const s of ['WORKING', 'ACTIVE', 'INACTIVE', 'RETIRED']) { const ctx = env(); const x = create(ctx, s, s === 'RETIRED' ? 'old' : null); assert.equal(x.code, 201, s); assert.equal(x.body.maintenance.action, 'none'); assert.equal(ctx.state.maintenance.length, 0) }
})
test('a maintenance sync failure never undoes or fails the equipment save (200 / 201, maintenance.action = error, equipment status saved)', () => {
  const ctx = env({ status: 'WORKING', failMaintenance: true }); const r = put(ctx, 'DAMAGED', 'x'); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'error'); assert.equal(ctx.state.equipment.status, 'DAMAGED')
  assert.equal(create(env({ failMaintenance: true }), 'DAMAGED', 'x').code, 201)
})
test('no signed-in user id -> the record is skipped (reported_by is required) while the equipment save still succeeds', () => {
  const ctx = env(); const r = put(ctx, 'DAMAGED', 'x', {}); assert.equal(r.code, 200); assert.equal(r.body.maintenance.action, 'skipped'); assert.equal(ctx.state.maintenance.length, 0)
})
test('response keeps every existing field (CP116) and only ADDS "maintenance"; equipment routes / permissions / Computers sync are unchanged', () => {
  const ctx = env(); const r = put(ctx, 'WORKING'); assert.equal(r.body.message, 'Update Successful'); assert.deepEqual(Object.keys(r.body.equipment).sort(), ['asset_tag', 'brand', 'computer_id', 'condition_note', 'equipment_type', 'id', 'laboratory_id', 'model', 'serial_number', 'status'])
  const fs = require('node:fs'); const base = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
  assert.match(base('controllers/computerController.js'), /syncComputerMaintenance/); assert.doesNotMatch(base('utils/computerMaintenanceSync.js'), /equipment_id/)
  assert.match(base('routes/equipmentRoutes.js'), /requireRole|requireAnyRole|authorize/i)
})

// ---- (B) the real sync SQL on SQLite (FROM DUAL and NOW() translated) ----
test('SQLite: the real INSERT ... WHERE NOT EXISTS guard and the completing UPDATE behave as intended, including repeated and concurrent-style runs', async () => {
  const { DatabaseSync } = require('node:sqlite'); const sqlite = new DatabaseSync(':memory:')
  sqlite.exec("CREATE TABLE maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, computer_id INT, equipment_id INT, reported_by INT NOT NULL, issue_description TEXT, status TEXT NOT NULL DEFAULT 'PENDING', maintenance_note TEXT, date_resolved TEXT)")
  const tr = sql => sql.replace(/ FROM DUAL/gi, '').replace(/\bNOW\(\)/gi, "'2026-11-12 10:00:00'")
  const db = { query(sql, values, cb) { try { const t = tr(sql); if (/^\s*INSERT|^\s*UPDATE/i.test(t)) { const r = sqlite.prepare(t).run(...values); cb(null, { affectedRows: Number(r.changes), insertId: Number(r.lastInsertRowid) }) } else cb(null, sqlite.prepare(t).all(...values)) } catch (e) { cb(e) } } }
  const { syncEquipmentMaintenance } = require('../utils/equipmentMaintenanceSync.js'); const run = args => new Promise((resolve, reject) => syncEquipmentMaintenance(db, args, (e, o) => e ? reject(e) : resolve(o)))
  const rows = () => sqlite.prepare('SELECT * FROM maintenance ORDER BY id').all()
  assert.equal((await run({ equipmentId: 9, before: 'WORKING', after: 'DAMAGED', note: 'n', userId: 2 })).action, 'created')
  assert.equal((await run({ equipmentId: 9, before: 'WORKING', after: 'DAMAGED', note: 'n', userId: 2 })).action, 'exists', 'second identical request cannot duplicate')
  assert.equal((await Promise.all([1, 2, 3].map(() => run({ equipmentId: 9, before: 'ACTIVE', after: 'MISSING', note: 'm', userId: 3 })))).filter(o => o.action === 'created').length, 0)
  assert.equal((await run({ equipmentId: 10, before: 'WORKING', after: 'DAMAGED', note: 'n', userId: 2 })).action, 'created'); assert.equal(rows().length, 2)
  sqlite.prepare("INSERT INTO maintenance (computer_id, reported_by, issue_description, status) VALUES (9, 2, 'computer #9', 'PENDING')").run()
  const closed = await run({ equipmentId: 9, before: 'DAMAGED', after: 'WORKING', userId: 2 }); assert.deepEqual(closed, { action: 'closed', count: 1 })
  const all = rows(); assert.equal(all.length, 3, 'history kept'); assert.equal(all[0].status, 'COMPLETED'); assert.equal(all[0].date_resolved, '2026-11-12 10:00:00'); assert.match(all[0].maintenance_note, /set back to Working/)
  assert.equal(all[1].status, 'PENDING', 'other equipment untouched'); assert.equal(all[2].status, 'PENDING', 'computer #9 record untouched')
  assert.equal((await run({ equipmentId: 9, before: 'DAMAGED', after: 'ACTIVE', userId: 2 })).action, 'none')
  assert.equal((await run({ equipmentId: 9, before: 'WORKING', after: 'DAMAGED', note: 'again', userId: 2 })).action, 'created'); assert.equal(rows().length, 4)
})
