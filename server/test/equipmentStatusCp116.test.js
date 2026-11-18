'use strict'
// CP116 MOCKED tests (fake db injected; they prove controller/validation logic, not real MySQL behaviour).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const fs = require('node:fs')

function load(options = [], usage = 3) {
  const calls = []
  const fakeDb = { query(sql, values, callback) {
    const text = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: text, values })
    if (text.startsWith('SELECT id, category, value FROM lookup_options WHERE id')) return callback(null, options.filter(o => o.id === values[0]))
    if (text.startsWith('SELECT id, category, value FROM lookup_options WHERE category')) return callback(null, options.filter(o => o.category === values[0]))
    if (text.startsWith('INSERT INTO lookup_options')) { const [category, value] = values; if (options.some(o => o.category === category && o.value.toLowerCase() === value.toLowerCase())) return callback(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })); const o = { id: options.length + 1, category, value }; options.push(o); return callback(null, { insertId: o.id, affectedRows: 1 }) }
    if (text.includes('FROM recycle_bin')) return callback(null, [{ total: 0 }])
    if (text.startsWith('SELECT COUNT(*) AS total FROM `')) return callback(null, [{ total: usage }])
    if (text.startsWith('DELETE FROM lookup_options')) { const i = options.findIndex(o => o.id === values[0]); if (i < 0) return callback(null, { affectedRows: 0 }); options.splice(i, 1); return callback(null, { affectedRows: 1 }) }
    callback(new Error('Unexpected SQL: ' + text)) } }
  const dbPath = path.resolve(__dirname, '../database/db.js'), auditPath = path.resolve(__dirname, '../utils/auditLogger.js'), cPath = path.resolve(__dirname, '../controllers/lookupOptionController.js')
  for (const [file, exp] of [[dbPath, fakeDb], [auditPath, { logAudit() {} }]]) { const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exp; require.cache[file] = m }
  delete require.cache[cPath]
  return { controller: require('../controllers/lookupOptionController.js'), calls, options }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const MIS = { id: 1, role: 'MIS' }, STAFF = { id: 2, role: 'Inventory Staff' }

test('built-in equipment statuses include Active and Inactive: re-adding them (any case/spacing) is refused and nothing is stored', () => {
  const { controller, options, calls } = load()
  for (const value of ['Active', ' active ', 'INACTIVE', 'inactive', 'Working', 'not working']) { const r = res(); controller.createOption({ body: { category: 'equipment_status', value }, user: MIS }, r); assert.ok([200, 400, 409].includes(r.code) && r.code !== 201, `${value} -> ${r.code}`) }
  assert.equal(options.length, 0); assert.ok(!calls.some(c => c.sql.startsWith('INSERT')))
})
test('a custom equipment status is saved once (MIS and MIS Staff), a duplicate custom value is refused, and it is listed', () => {
  const { controller, options } = load()
  for (const user of [MIS, STAFF]) { const r = res(); controller.createOption({ body: { category: 'equipment_status', value: user === MIS ? 'On Loan' : 'For Disposal' }, user }, r); assert.equal(r.code, 201) }
  const dup = res(); controller.createOption({ body: { category: 'equipment_status', value: 'on loan' }, user: STAFF }, dup); assert.equal(dup.code, 409)
  assert.deepEqual(options.map(o => o.value), ['On Loan', 'For Disposal'])
  const list = res(); controller.getOptions({ query: { category: 'equipment_status' }, user: STAFF }, list); assert.equal(list.body.options.length, 2)
})
test('Dean and Teacher can neither add, list nor delete equipment statuses', async () => {
  const { controller, options } = load([{ id: 1, category: 'equipment_status', value: 'On Loan' }])
  for (const role of ['Dean', 'Teacher', 'Others']) {
    const a = res(); controller.createOption({ body: { category: 'equipment_status', value: 'X' }, user: { id: 9, role } }, a); assert.equal(a.code, 403, role)
    const l = res(); controller.getOptions({ query: { category: 'equipment_status' }, user: { id: 9, role } }, l); assert.equal(l.code, 403, role)
    const d = res(); await controller.deleteOption({ params: { id: '1' }, user: { id: 9, role } }, d); assert.equal(d.code, 403, role)
  }
  assert.equal(options.length, 1)
})
test('CP137 custom equipment statuses are deletable by MIS and MIS Staff when no equipment uses them; in use -> 409 and nothing deleted', async () => {
  { const { controller, options } = load([{ id: 7, category: 'equipment_status', value: 'On Loan' }], 2); const r = res(); await controller.deleteOption({ params: { id: '7' }, user: MIS }, r); assert.equal(r.code, 409); assert.equal(r.body.inUse, true); assert.equal(options.length, 1) }
  for (const user of [MIS, STAFF]) {
    const { controller, options, calls } = load([{ id: 7, category: 'equipment_status', value: 'On Loan' }], 0)
    const r = res(); await controller.deleteOption({ params: { id: '7' }, user }, r)
    assert.equal(r.code, 200); assert.equal(options.length, 0)
    assert.ok(!calls.some(c => /^UPDATE/.test(c.sql)), 'equipment records are not touched')
  }
})
test('default statuses (incl. Active / Inactive) are protected from deletion even if such a row ever existed', async () => {
  for (const value of ['ACTIVE', 'Inactive', 'WORKING', 'not working']) {
    const { controller, options } = load([{ id: 3, category: 'equipment_status', value }])
    const r = res(); await controller.deleteOption({ params: { id: '3' }, user: MIS }, r)
    assert.equal(r.code, 400, value); assert.equal(r.body.message, 'Default options cannot be deleted.'); assert.equal(options.length, 1)
  }
})
test('condition note: ACTIVE, INACTIVE and WORKING need none; every other status (incl. custom) still requires one', () => {
  const { equipmentNoteError, EQUIPMENT_DEFAULT_STATUSES } = require('../utils/equipmentStatus.js')
  for (const s of ['ACTIVE', 'Inactive', ' working ']) assert.equal(equipmentNoteError(s, ''), null, s)
  for (const s of ['UNDER REPAIR', 'DAMAGED', 'MISSING', 'RETIRED', 'On Loan']) assert.match(equipmentNoteError(s, ''), /condition note is required/i, s)
  assert.equal(equipmentNoteError('On Loan', 'lent to Lab 2'), null)
  assert.deepEqual(EQUIPMENT_DEFAULT_STATUSES, ['WORKING', 'ACTIVE', 'INACTIVE', 'NOT WORKING'])
})
test('shared recordValidation (used by Computers) is unchanged: ACTIVE still needs a note there', () => {
  const { conditionNoteError } = require('../utils/recordValidation.js')
  assert.match(conditionNoteError('ACTIVE', ''), /required/); assert.equal(conditionNoteError('WORKING', ''), null)
})
test('equipment controller uses the equipment-only note rule', () => {
  const ctrl = fs.readFileSync(path.join(__dirname, '../controllers/equipmentController.js'), 'utf8')
  assert.equal((ctrl.match(/equipmentNoteError\(status, condition_note\)/g) || []).length, 2); assert.ok(!/conditionNoteError/.test(ctrl))
})
test('Excel import: ACTIVE / INACTIVE are valid equipment statuses with no note; other non-WORKING statuses still need a note', () => {
  const { validateRows } = require('../utils/excelImportValidation.js')
  const reference = { laboratories: [{ id: 1 }], computers: [], existingTags: [], existingSerials: [], options: {} }
  const row = (n, status, note = '') => ({ rowNumber: n, data: { equipment_type: 'Projector', laboratory_id: 1, asset_tag: `EQ-${n}`, serial_number: `SN-${n}`, status, condition_note: note } })
  const out = validateRows([row(2, 'ACTIVE'), row(3, 'INACTIVE'), row(4, 'WORKING'), row(5, 'DAMAGED'), row(6, 'DAMAGED', 'cracked'), row(7, 'NOT-A-STATUS', 'x')], 'equipment', reference)
  assert.deepEqual(out.map(r => r.valid), [true, true, true, false, true, false])
  assert.match(out[3].errors.join(' '), /Condition note is required unless status is WORKING, ACTIVE or INACTIVE/)
  assert.match(out[5].errors.join(' '), /not a configured option/)
})

// CP136: Not Working is a default equipment status, needs a note, and is a maintenance need; Active/Inactive/Working behave as before.
test('CP136 Not Working: needs a note and opens maintenance; Active/Inactive/Working do not', () => {
  const { equipmentNoteError } = require('../utils/equipmentStatus.js'); const { needsMaintenance } = require('../utils/equipmentMaintenanceSync.js')
  assert.match(equipmentNoteError('NOT WORKING', ''), /condition note is required/i)
  assert.equal(equipmentNoteError('NOT WORKING', 'screen dead'), null)
  assert.equal(needsMaintenance('NOT WORKING'), true); assert.equal(needsMaintenance('Overheating'), true)
  for (const s of ['WORKING', 'ACTIVE', 'INACTIVE']) assert.equal(needsMaintenance(s), false, s)
})
