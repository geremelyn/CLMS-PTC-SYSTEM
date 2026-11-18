// CP61 - Report Issue: Equipment Type + Specific Equipment dropdowns.
// UNIT (real execution): helpers in client/src/utils/reportIssueEquipment.mjs.
// SOURCE-LEVEL: ReportIssue.jsx wiring is checked by reading the file (no React render, no browser).
// SQLITE (node:sqlite, NOT MySQL/MariaDB): the real createMaintenance controller + its real SQL against in-memory tables.
// No real MySQL/MariaDB, HTTP, login session or browser is involved.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')
const { DatabaseSync } = require('node:sqlite')
const helpers = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/reportIssueEquipment.mjs')).href)
const pageSrc = () => fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/ReportIssue.jsx'), 'utf8')

const EQUIPMENT = [
  { id: 1, equipment_type: 'Keyboard', asset_tag: 'EQ-L1-001', brand: 'Logitech', model: 'K120', laboratory_id: 1 },
  { id: 2, equipment_type: 'Keyboard', asset_tag: 'EQ-L1-002', laboratory_id: 1 },
  { id: 3, equipment_type: 'Mouse', asset_tag: 'EQ-L1-003', laboratory_id: 1 },
  { id: 4, equipment_type: 'keyboard ', asset_tag: 'EQ-L2-001', laboratory_id: 2 },
  { id: 5, equipment_type: 'Printer', asset_tag: 'EQ-L2-002', laboratory_id: null, effective_laboratory_id: 2 },
  { id: 6, equipment_type: 'Monitor', asset_tag: 'EQ-L1-004', laboratory_id: 1 }
]

test('equipment type options come from the registered equipment of the chosen laboratory (distinct, alphabetical)', async () => {
  const h = await helpers()
  assert.deepEqual(h.equipmentTypesForLaboratory(EQUIPMENT, 1), ['Keyboard', 'Monitor', 'Mouse'])
  assert.deepEqual(h.equipmentTypesForLaboratory(EQUIPMENT, '2'), ['keyboard', 'Printer'], 'case-insensitive de-duplication; effective lab fallback used')
  assert.deepEqual(h.equipmentTypesForLaboratory(EQUIPMENT, ''), []); assert.deepEqual(h.equipmentTypesForLaboratory([], 1), [])
})

test('specific equipment contains only records of the chosen type (and laboratory), with a useful label', async () => {
  const h = await helpers()
  assert.deepEqual(h.equipmentForType(EQUIPMENT, 1, 'Keyboard').map(i => i.id), [1, 2])
  assert.deepEqual(h.equipmentForType(EQUIPMENT, 1, 'Mouse').map(i => i.id), [3])
  assert.deepEqual(h.equipmentForType(EQUIPMENT, 2, 'Keyboard').map(i => i.id), [4])
  assert.deepEqual(h.equipmentForType(EQUIPMENT, 1, ''), [], 'nothing is listed before a type is chosen')
  assert.deepEqual(h.equipmentForType(EQUIPMENT, 1, 'Printer'), [], 'a type from another laboratory is not listed')
  assert.equal(h.equipmentOptionLabel(EQUIPMENT[0]), 'Keyboard — EQ-L1-001 · Logitech · K120'); assert.equal(h.equipmentOptionLabel(EQUIPMENT[1]), 'Keyboard — EQ-L1-002')
})

test('selection is valid only for an ID that belongs to the chosen laboratory + type', async () => {
  const h = await helpers()
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, 'Keyboard', '1'), true)
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, 'Keyboard', 3), false, 'a Mouse is not valid for Keyboard')
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, 'Keyboard', 4), false, 'other laboratory')
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, 'Keyboard', ''), false); assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, 'Keyboard', 999), false)
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, 1, '', 1), false)
})

test('changing the type clears the previous equipment selection (state flow modelled on the page handlers; page wiring checked below)', async () => {
  const h = await helpers()
  let state = { laboratoryId: 1, equipmentType: '', equipmentId: '' }
  const onType = type => { state = { ...state, equipmentType: type, equipmentId: '' } } // same two setters as the page's onChange
  onType('Keyboard'); state.equipmentId = '1'
  assert.equal(h.isValidEquipmentSelection(EQUIPMENT, state.laboratoryId, state.equipmentType, state.equipmentId), true)
  onType('Mouse')
  assert.equal(state.equipmentId, ''); assert.equal(h.isValidEquipmentSelection(EQUIPMENT, state.laboratoryId, state.equipmentType, state.equipmentId), false, 'submission blocked until a new specific item is picked')
  assert.deepEqual(h.equipmentForType(EQUIPMENT, state.laboratoryId, state.equipmentType).map(i => i.id), [3])
})

test('page wiring: two new dropdowns for Equipment only, type change clears the item, laboratory/asset-type change clears both, submit is gated', () => {
  const src = pageSrc()
  assert.match(src, /id="report-equipment-type"/); assert.match(src, /Specific Equipment/); assert.match(src, /equipmentTypes\.map/); assert.match(src, /filteredEquipment\.map\(item => <option key=\{item\.id\} value=\{item\.id\}>/)
  assert.match(src, /setEquipmentType\(event\.target\.value\); setEquipmentId\(''\)/)
  assert.match(src, /setLaboratoryId\(event\.target\.value\); setAssetType\(presetType\); setComputerId\(''\); setEquipmentType\(''\); setEquipmentId\(''\)/)
  assert.match(src, /setAssetType\(event\.target\.value\); setComputerId\(''\); setEquipmentType\(''\); setEquipmentId\(''\)/)
  assert.match(src, /disabled=\{!equipmentType\}/)
  assert.match(src, /isValidEquipmentSelection\(equipment, laboratoryId, equipmentType, equipmentId\)/)
  assert.match(src, /equipment_id: assetType === 'EQUIPMENT' \? equipmentId : null/); assert.match(src, /equipment_type: assetType === 'EQUIPMENT' \? equipmentType : null/)
  assert.match(src, /api\.get\('\/equipment'\)/, 'reuses the existing equipment endpoint')
  assert.doesNotMatch(src, /Keyboard|EQ-L1/, 'no hardcoded example equipment')
})

test('page keeps the Computer flow and the other fields unchanged', () => {
  const src = pageSrc()
  assert.match(src, /assetType === 'COMPUTER' && !computerId/); assert.match(src, /computer_id: assetType === 'COMPUTER' \? computerId : null/); assert.match(src, /id="report-computer"/)
  assert.match(src, /Submit this maintenance report\?/); assert.match(src, /api\.post\('\/maintenance'/)
})

// ---------------- SQLite: real controller + real SQL ----------------
function makeDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE computers (id INTEGER PRIMARY KEY, computer_name TEXT, laboratory_id INT, asset_tag TEXT);
    CREATE TABLE equipment (id INTEGER PRIMARY KEY, equipment_type TEXT, laboratory_id INT, computer_id INT, asset_tag TEXT);
    CREATE TABLE maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, computer_id INT, equipment_id INT, reported_by INT, issue_description TEXT, status TEXT DEFAULT 'PENDING');
    INSERT INTO computers VALUES (10, 'PC-1', 1, 'PC-TAG-1'), (11, 'PC-2', 2, 'PC-TAG-2');
    INSERT INTO equipment VALUES (1, 'Keyboard', 1, NULL, 'EQ-L1-001'), (2, 'Mouse', 1, NULL, 'EQ-L1-003'), (3, 'Keyboard', 2, NULL, 'EQ-L2-001'), (4, 'Printer', NULL, 11, 'EQ-L2-002');`)
  return { sqlite, query(sql, values, cb) { if (typeof values === 'function') { cb = values; values = [] } try { const st = sqlite.prepare(sql); if (/^\s*SELECT/i.test(sql)) return cb(null, st.all(...(values || [])).map(r => ({ ...r }))); const r = st.run(...(values || [])); cb(null, { insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }) } catch (e) { cb(e) } } }
}
function load(db) {
  const stub = (rel, exp) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exp; require.cache[p] = m }
  stub('../database/db.js', db); stub('../utils/auditLogger.js', { logAudit() {} })
  const cp = path.resolve(__dirname, '../controllers/maintenanceController.js'); delete require.cache[cp]; return require(cp)
}
const call = (controller, body) => new Promise(resolve => { const res = { code: 200, status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }) } }; controller.createMaintenance({ body, user: { id: 7, role: 'Teacher' } }, res) })
const rowsOf = db => db.sqlite.prepare('SELECT * FROM maintenance').all()

test('SQLITE: equipment report is linked to the actual equipment ID when laboratory and type match', async () => {
  const db = makeDb(), c = load(db)
  const r = await call(c, { laboratory_id: 1, equipment_id: 1, equipment_type: 'Keyboard', issue_description: 'Keys stuck' })
  assert.equal(r.code, 201); const [row] = rowsOf(db)
  assert.equal(row.equipment_id, 1); assert.equal(row.computer_id, null); assert.equal(row.reported_by, 7); assert.equal(row.status, 'PENDING')
  const ci = await call(c, { laboratory_id: 2, equipment_id: 4, equipment_type: 'printer', issue_description: 'Jam' }) // lab inherited from its computer; type match is case-insensitive
  assert.equal(ci.code, 201)
})

test('SQLITE: mismatched type, wrong laboratory, unknown ID and bad values are rejected and nothing is inserted', async () => {
  const db = makeDb(), c = load(db)
  const bad = async (body, code, re) => { const r = await call(c, { issue_description: 'x', ...body }); assert.equal(r.code, code, JSON.stringify(body)); assert.match(r.body.message, re) }
  await bad({ laboratory_id: 1, equipment_id: 2, equipment_type: 'Keyboard' }, 400, /does not match the selected equipment type/i) // ID 2 is a Mouse
  await bad({ laboratory_id: 1, equipment_id: 3, equipment_type: 'Keyboard' }, 400, /does not belong to the selected laboratory/i)
  await bad({ laboratory_id: 1, equipment_id: 999, equipment_type: 'Keyboard' }, 404, /not found/i)
  await bad({ laboratory_id: 1, equipment_id: 'abc', equipment_type: 'Keyboard' }, 400, /positive whole numbers/i)
  await bad({ laboratory_id: 1, equipment_id: 1, equipment_type: { $ne: 1 } }, 400, /invalid/i)
  await bad({ laboratory_id: 1, equipment_id: 1, equipment_type: 'K'.repeat(101) }, 400, /invalid/i)
  await bad({ laboratory_id: 1, computer_id: 10, equipment_type: 'Keyboard' }, 400, /only be sent together with an equipment/i)
  await bad({ laboratory_id: 1, computer_id: 10, equipment_id: 1, equipment_type: 'Keyboard' }, 400, /exactly one/i)
  assert.equal(rowsOf(db).length, 0)
})

test('SQLITE: existing behaviour preserved - Computer reports, and equipment reports sent without a type (older clients)', async () => {
  const db = makeDb(), c = load(db)
  assert.equal((await call(c, { laboratory_id: 1, computer_id: 10, equipment_id: null, equipment_type: null, issue_description: 'No boot' })).code, 201)
  assert.equal((await call(c, { laboratory_id: 1, computer_id: 11, issue_description: 'x' })).code, 400, 'computer of another laboratory still rejected')
  assert.equal((await call(c, { laboratory_id: 1, equipment_id: 2, issue_description: 'Dead' })).code, 201, 'type is optional on the API')
  assert.deepEqual(rowsOf(db).map(r => [r.computer_id, r.equipment_id]), [[10, null], [null, 2]])
})

test('SOURCE-LEVEL: route permissions unchanged (Teacher/Dean create; MIS/Inventory read)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../routes/maintenanceRoutes.js'), 'utf8')
  assert.match(src, /router\.post\('\/', requireRole\('Teacher','Dean','Others'\), createMaintenance\)/); assert.match(src, /router\.get\('\/', requireRole\('MIS','Inventory Staff'\), getMaintenance\)/)
})
