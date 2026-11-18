'use strict'
// CP112 - custom Final Asset Condition in Maintenance History.
// MOCKED db (no real MySQL) for the controllers; SOURCE-LEVEL checks for the page wiring and the route/role rules.
// Browser behaviour (popup, dropdown, delete symbol) is covered separately by tools/browser-tests/group3/t32.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const inject = (file, exports) => { const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m }
const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js')

function loadMaintenance({ maintenance = {}, saved = [] } = {}) {
  const calls = []
  const current = { id: 5, status: 'IN PROGRESS', computer_id: 10, equipment_id: null, issue_description: 'Cracked screen', maintenance_note: null, date_resolved: null, ...maintenance }
  const connection = {
    beginTransaction(cb) { calls.push('BEGIN'); cb(null) }, commit(cb) { calls.push('COMMIT'); cb(null) }, rollback(cb) { calls.push('ROLLBACK'); cb(null) }, release() {},
    query(sql, values, cb) {
      const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: n, values: values || [] })
      if (n.startsWith('SELECT * FROM maintenance')) return cb(null, [current])
      if (n.startsWith('SELECT value FROM lookup_options')) return cb(null, saved.filter(r => r.category === values[0] && r.value.toLowerCase() === String(values[1]).toLowerCase()))
      if (n.startsWith('SELECT operational_status')) return cb(null, [{ operational_status: 'INACTIVE', condition: 'UNDER REPAIR', condition_note: null }])
      if (n.startsWith('SELECT status, condition_note FROM equipment')) return cb(null, [{ status: 'UNDER REPAIR', condition_note: null }])
      if (n.startsWith('SELECT id FROM computers')) return cb(null, [{ id: 10 }])
      if (n.startsWith('SELECT id FROM equipment')) return cb(null, [{ id: 20 }])
      if (n.startsWith('INSERT INTO undo_actions')) return cb(null, { insertId: 91 })
      if (/^UPDATE (computers|equipment|maintenance)/.test(n)) return cb(null, { affectedRows: 1 })
      cb(new Error('Unexpected SQL: ' + n))
    }
  }
  inject(dbPath, { getConnection(cb) { calls.push('GET_CONNECTION'); cb(null, connection) } }); inject(auditPath, { logAudit() {} })
  const cp = path.resolve(__dirname, '../controllers/maintenanceController.js'); delete require.cache[cp]
  return { controller: require(cp), calls }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const sqlCalls = calls => calls.filter(c => typeof c === 'object')
const complete = (controller, body) => { const r = res(); return controller.updateMaintenance({ params: { id: '5' }, body: { status: 'COMPLETED', maintenance_note: 'Replaced screen', ...body }, user: { id: 2, role: 'MIS' } }, r).then(() => r) }

test('SAVING/USING: a saved custom condition is accepted for a computer and written to computers.condition', async () => {
  const { controller, calls } = loadMaintenance({ saved: [{ category: 'computer_condition', value: 'Needs Parts' }] })
  const r = await complete(controller, { final_condition: 'Needs Parts' })
  assert.equal(r.code, 200); assert.equal(r.body.maintenance.final_condition, 'Needs Parts')
  const u = sqlCalls(calls).find(c => c.sql.startsWith('UPDATE computers'))
  assert.deepEqual([u.values[0], u.values[1]], ['INACTIVE', 'Needs Parts']); assert.ok(u.values[2], 'non-working keeps a condition note'); assert.ok(calls.includes('COMMIT'))
  assert.equal(sqlCalls(calls).find(c => c.sql.startsWith('SELECT value FROM lookup_options')).values[0], 'computer_condition')
})
test('a saved custom condition is accepted for equipment (equipment_status list) and written to equipment.status', async () => {
  const { controller, calls } = loadMaintenance({ maintenance: { computer_id: null, equipment_id: 20 }, saved: [{ category: 'equipment_status', value: 'For Disposal' }, { category: 'computer_condition', value: 'Needs Parts' }] })
  const r = await complete(controller, { final_condition: 'For Disposal' })
  assert.equal(r.code, 200)
  assert.equal(sqlCalls(calls).find(c => c.sql.startsWith('UPDATE equipment')).values[0], 'For Disposal')
  const r2 = await complete(loadMaintenance({ maintenance: { computer_id: null, equipment_id: 20 }, saved: [{ category: 'computer_condition', value: 'Needs Parts' }] }).controller, { final_condition: 'Needs Parts' })
  assert.equal(r2.code, 400, "another asset type's custom list is not valid for equipment")
})
test('SELECTING: matching is case-insensitive and the saved spelling is what gets stored', async () => {
  const { controller, calls } = loadMaintenance({ saved: [{ category: 'computer_condition', value: 'Needs Parts' }] })
  const r = await complete(controller, { final_condition: '  needs parts ' })
  assert.equal(r.code, 200); assert.equal(sqlCalls(calls).find(c => c.sql.startsWith('UPDATE computers')).values[1], 'Needs Parts')
})
test('an unsaved/deleted custom condition is rejected: 400, nothing written, rolled back', async () => {
  const { controller, calls } = loadMaintenance({ saved: [] })
  const r = await complete(controller, { final_condition: 'Needs Parts' })
  assert.equal(r.code, 400); assert.match(r.body.message, /Add it through Others first/)
  assert.ok(!sqlCalls(calls).some(c => /^UPDATE (computers|equipment|maintenance)/.test(c.sql))); assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.includes('COMMIT'))
})
test('invalid values rejected before touching the database (empty, blank, too long, not a string)', async () => {
  for (const bad of [undefined, '', '   ', 'x'.repeat(51), 42, ['WORKING']]) {
    const { controller, calls } = loadMaintenance(); const r = await complete(controller, { final_condition: bad })
    assert.equal(r.code, 400, String(bad)); assert.ok(!calls.includes('GET_CONNECTION'))
  }
  const { controller } = loadMaintenance({ saved: [{ category: 'computer_condition', value: 'x'.repeat(50) }] })
  assert.equal((await complete(controller, { final_condition: 'x'.repeat(50) })).code, 200, '50 characters is allowed (VARCHAR(50))')
})
test('PRESERVED: the fixed conditions behave exactly as before and never query lookup_options', async () => {
  for (const [value, status] of [['WORKING', 'ACTIVE'], ['DAMAGED', 'INACTIVE'], ['RETIRED', 'INACTIVE'], ['UNDER REPAIR', 'INACTIVE'], ['MISSING', 'INACTIVE']]) {
    const { controller, calls } = loadMaintenance(); const r = await complete(controller, { final_condition: value })
    assert.equal(r.code, 200, value); const u = sqlCalls(calls).find(c => c.sql.startsWith('UPDATE computers'))
    assert.deepEqual([u.values[0], u.values[1]], [status, value]); assert.equal(u.values[2] === null, value === 'WORKING')
    assert.ok(!sqlCalls(calls).some(c => c.sql.includes('lookup_options')))
  }
})
test('PRESERVED: the final condition is only evaluated when completing (IN PROGRESS / others unaffected)', async () => {
  const { controller, calls } = loadMaintenance({ maintenance: { status: 'PENDING' } }); const r = res()
  await controller.updateMaintenance({ params: { id: '5' }, body: { status: 'IN PROGRESS', maintenance_note: 'x', final_condition: 'Whatever' }, user: { id: 2, role: 'MIS' } }, r)
  assert.equal(r.code, 200); assert.ok(!sqlCalls(calls).some(c => c.sql.includes('lookup_options')))
})

// ---- deleting: custom only, defaults protected (existing option controller + routes) ----
function loadOptions({ options = [], usage = 0 } = {}) {
  const calls = []
  inject(dbPath, { query(sql, values, cb) { const t = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: t, values })
    if (t.startsWith('SELECT id, category, value FROM lookup_options WHERE id')) return cb(null, options.filter(o => o.id === values[0]))
    if (t.startsWith('DELETE FROM lookup_options')) { const i = options.findIndex(o => o.id === values[0]); if (i < 0) return cb(null, { affectedRows: 0 }); options.splice(i, 1); return cb(null, { affectedRows: 1 }) }
    if (t.includes('FROM recycle_bin')) return cb(null, [{ total: 0 }])
    if (t.startsWith('SELECT COUNT(*) AS total FROM `')) return cb(null, [{ total: usage }])
    if (t.startsWith('INSERT INTO lookup_options')) { options.push({ id: 50, category: values[0], value: values[1] }); return cb(null, { insertId: 50 }) }
    cb(new Error('Unexpected SQL: ' + t)) } })
  inject(auditPath, { logAudit() {} })
  const cp = path.resolve(__dirname, '../controllers/lookupOptionController.js'); delete require.cache[cp]
  return { c: require(cp), calls, options }
}
test('SAVING (Others): a new custom condition is stored in the existing options list; built-in names are refused', async () => {
  const { c, options } = loadOptions(); let r = res()
  c.createOption({ body: { category: 'computer_condition', value: 'Needs Parts' }, user: { id: 1, role: 'MIS' } }, r)
  assert.equal(r.code, 201); assert.deepEqual(options.map(o => o.value), ['Needs Parts'])
  for (const builtIn of ['working', 'not working', 'ACTIVE']) { r = res(); c.createOption({ body: { category: 'equipment_status', value: builtIn }, user: { id: 1, role: 'MIS' } }, r); assert.equal(r.code, 409, builtIn) }
})
test('DELETING: a custom condition can be deleted (MIS and MIS Staff); records keep their value', async () => {
  for (const role of ['MIS', 'Inventory Staff']) {
    const { c, options } = loadOptions({ options: [{ id: 7, category: 'computer_condition', value: 'Needs Parts' }] }); const r = res()
    await c.deleteOption({ params: { id: '7' }, user: { id: 1, role } }, r)
    assert.equal(r.code, 200, role); assert.equal(options.length, 0); assert.match(r.body.message, /Existing records keep their value/)
  }
})
test('CP137 DELETING: a custom condition still used by a computer / equipment record cannot be deleted', async () => {
  for (const category of ['computer_condition', 'equipment_status']) {
    const { c, options } = loadOptions({ options: [{ id: 7, category, value: 'Needs Parts' }], usage: 1 }); const r = res()
    await c.deleteOption({ params: { id: '7' }, user: { id: 1, role: 'MIS' } }, r)
    assert.equal(r.code, 409, category); assert.equal(r.body.inUse, true); assert.match(r.body.message, /still used by/); assert.equal(options.length, 1)
  }
})
test('PROTECTION: default conditions can never be deleted, even if a row with that name somehow exists', async () => {
  for (const [category, value] of [['computer_condition', 'WORKING'], ['computer_condition', 'not working'], ['equipment_status', 'NOT WORKING'], ['equipment_status', 'INACTIVE'], ['equipment_status', 'ACTIVE']]) {
    const { c, options, calls } = loadOptions({ options: [{ id: 3, category, value }] }); const r = res()
    await c.deleteOption({ params: { id: '3' }, user: { id: 1, role: 'MIS' } }, r)
    assert.equal(r.code, 400, value); assert.match(r.body.message, /Default options cannot be deleted/); assert.equal(options.length, 1); assert.ok(!calls.some(x => x.sql.startsWith('DELETE')))
  }
})
test('PERMISSIONS: option routes stay MIS / MIS Staff only (Dean, Teacher, custom roles cannot create or delete)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/lookupOptionRoutes.js'), 'utf8')
  assert.match(src, /router\.post\('\/', requireRole\('MIS','Inventory Staff'\), createOption\)/); assert.match(src, /router\.delete\('\/:id', requireRole\('MIS','Inventory Staff'\), deleteOption\)/)
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/maintenanceRoutes.js'), 'utf8'), /requireRole\('MIS','Inventory Staff'\)/)
})
test('PAGE WIRING: Maintenance History uses OptionSelect with Others + delete-for-custom-only; defaults are not custom', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/Maintenance.jsx'), 'utf8')
  assert.match(src, /import OptionSelect from '..\/components\/OptionSelect\.jsx'/)
  assert.match(src, /DEFAULT_CONDITIONS = \[\['WORKING', 'Working'\]\]/)
  assert.match(src, /DEFAULT_CONDITIONS\.map\(\(\[value, label\]\) => \(\{ value, label, custom: false \}\)\)/)
  assert.match(src, /custom: true, id: option\.id/)
  assert.match(src, /onOthers=\{chooseOtherCondition\}/); assert.match(src, /onDeleteCustom=\{deleteCustomCondition\}/)
  assert.match(src, /api\.post\('\/options', \{ category: conditionCategory/); assert.match(src, /api\.delete\(`\/options\/\$\{option\.id\}`\)/)
  assert.match(src, /conditionCategory = editingMaintenance\?\.computer_id \? 'computer_condition' : 'equipment_status'/)
  const ui = fs.readFileSync(path.join(__dirname, '../../client/src/components/OptionSelect.jsx'), 'utf8')
  assert.match(ui, /option\.custom && onDeleteCustom/)
})
