'use strict'
// CP171 - Equipment Status (Active / Inactive / Others) in the Excel template, import, export and Save as PDF; kept separate from Condition.
// REAL code: template builder, workbook writer/parser, validator, export controller, PDF HTML builder. MOCKED: database (import commit) - no real MySQL.
// NOT covered: opening the files in real Excel / a real PDF viewer / a browser print dialog.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')
const { SPECS, FIELD_MAPS, buildTemplate } = require('../utils/importTemplates.js')
const { validateRows, mapRow } = require('../utils/excelImportValidation.js')
const { parseWorkbookRows } = require('../utils/excelWorkbookRows.js')
const { workbookXml } = require('../utils/xlsxWriter.js')
const { parseXlsx } = require('../utils/xlsxParser.js')
const { createExcelExportController } = require('../controllers/excelExportController.js')

const REF = { laboratories: [{ id: 1, capacity: 40 }], computers: [], options: { equipment_status: [], equipment_state: ['Reserved'] } }
const NEW_HEADERS = SPECS.equipment.columns.map(c => c.header)
const rowOf = (o = {}) => { const d = { 'Equipment Type': 'Projector', 'Laboratory ID': 1, 'Computer Assignment (ID or exact computer name)': '', 'Asset Tag': 'EQ-1', 'Serial Number': 'SN-1', Brand: 'Epson', Model: 'X500', Status: 'ACTIVE', Condition: 'WORKING', 'Condition Note': '', ...o }; return NEW_HEADERS.map(h => d[h] ?? '') }
const check = (headers, rows) => validateRows(rows.map((values, i) => ({ rowNumber: i + 2, data: mapRow(headers, values, 'equipment') })), 'equipment', REF)

test('TEMPLATE: Status (Active / Inactive / Others, optional) and Condition are separate columns, in the real generated .xlsx', () => {
  const cols = SPECS.equipment.columns, idx = h => cols.findIndex(c => c.header === h)
  assert.ok(idx('Status') >= 0 && idx('Condition') === idx('Status') + 1 && idx('Condition Note') === idx('Condition') + 1)
  const status = cols[idx('Status')], condition = cols[idx('Condition')]
  assert.deepEqual([status.field, status.required, status.example], ['equipment_state', false, 'ACTIVE'])
  assert.match(status.note, /ACTIVE or INACTIVE/); assert.match(status.note, /custom status \(Others\)/); assert.match(status.note, /blank.*ACTIVE/i); assert.match(status.note, /Separate from Condition/)
  assert.deepEqual([condition.field, condition.required, condition.example], ['status', true, 'WORKING']); assert.match(condition.note, /WORKING or NOT WORKING/); assert.match(condition.note, /Separate from Status/)
  assert.equal(FIELD_MAPS.equipment.status, 'equipment_state'); assert.equal(FIELD_MAPS.equipment.condition, 'status')
  const sheets = parseXlsx(buildTemplate('equipment'))
  const all = JSON.stringify(sheets)
  assert.match(all, /ACTIVE or INACTIVE, or a custom status \(Others\)/); assert.match(all, /WORKING or NOT WORKING/)
  assert.ok(Object.values(sheets).some(rows => rows[0] && rows[0].includes('Status') && rows[0].includes('Condition')), 'both headers in the template sheet')
  for (const t of ['users', 'laboratories', 'computers']) assert.ok(!SPECS[t].columns.some(c => c.field === 'equipment_state'), t)
})

test('IMPORT (real .xlsx -> parser -> validator): Active, Inactive, a saved custom ("Others") status and a blank Status', () => {
  const rows = [rowOf({ 'Asset Tag': 'EQ-1', 'Serial Number': 'SN-1', Status: 'Active' }), rowOf({ 'Asset Tag': 'EQ-2', 'Serial Number': 'SN-2', Status: 'inactive' }),
    rowOf({ 'Asset Tag': 'EQ-3', 'Serial Number': 'SN-3', Status: 'Reserved', Condition: 'Not Working', 'Condition Note': 'Lamp out' }), rowOf({ 'Asset Tag': 'EQ-4', 'Serial Number': 'SN-4', Status: '' })]
  const parsed = parseWorkbookRows(workbookXml('Equipment Template', NEW_HEADERS, rows.map(r => r.map(String))), 'equipment', 'equipment.xlsx')
  const out = validateRows(parsed, 'equipment', REF)
  assert.deepEqual(out.map(r => r.errors), [[], [], [], []])
  assert.deepEqual(out.map(r => [r.data.equipment_state, r.data.status]), [['ACTIVE', 'WORKING'], ['INACTIVE', 'WORKING'], ['RESERVED', 'NOT WORKING'], ['ACTIVE', 'WORKING']], 'Status and Condition kept apart; blank Status = ACTIVE')
})

test('IMPORT: an unknown Status, a Condition value in the Status column, and an over-long Status are rejected with a Status-specific message', () => {
  const out = check(NEW_HEADERS, [rowOf({ Status: 'Banana' }), rowOf({ 'Asset Tag': 'EQ-2', 'Serial Number': 'SN-2', Status: 'WORKING' }), rowOf({ 'Asset Tag': 'EQ-3', 'Serial Number': 'SN-3', Status: 'x'.repeat(51) })])
  assert.match(out[0].errors.join(' '), /Status “BANANA” is not a configured option/); assert.match(out[1].errors.join(' '), /Status “WORKING” is not a configured option/); assert.match(out[2].errors.join(' '), /Status must be 50 characters or fewer/)
  const cond = check(NEW_HEADERS, [rowOf({ Condition: 'Odd' })])[0].errors.join(' ')
  assert.match(cond, /Condition “ODD” is not a configured option/); assert.doesNotMatch(cond, /Status/)
  assert.match(check(NEW_HEADERS, [rowOf({ Condition: '' })])[0].errors.join(' '), /status is required|condition|required/i, 'Condition stays required')
})

test('BACKWARD COMPATIBILITY: a file WITHOUT a Status column imports with Active (Condition column present)', () => {
  const headers = NEW_HEADERS.filter(h => h !== 'Status'), values = rowOf().filter((_, i) => NEW_HEADERS[i] !== 'Status')
  const [r] = check(headers, [values]); assert.deepEqual(r.errors, []); assert.deepEqual([r.data.equipment_state, r.data.status], ['ACTIVE', 'WORKING'])
})

test('BACKWARD COMPATIBILITY: an older file (Status column that held the Condition, no Condition column) still imports as before', () => {
  const OLD = ['Equipment Type', 'Laboratory ID', 'Computer Assignment (ID or exact computer name)', 'Asset Tag', 'Serial Number', 'Brand', 'Model', 'Status', 'Condition Note']
  const old = (tag, status, note = '') => ['Monitor', 1, '', tag, 'SN-' + tag, '', '', status, note]
  const out = check(OLD, [old('A1', 'WORKING'), old('A2', 'NOT WORKING', 'No signal'), old('A3', 'INACTIVE'), old('A4', 'ACTIVE'), old('A5', 'Damaged', 'Cracked'), old('A6', 'NOT WORKING', '')])
  assert.deepEqual(out.slice(0, 5).map(r => r.errors), [[], [], [], [], []])
  assert.deepEqual(out.slice(0, 5).map(r => [r.data.equipment_state, r.data.status]), [['ACTIVE', 'WORKING'], ['ACTIVE', 'NOT WORKING'], ['INACTIVE', 'WORKING'], ['ACTIVE', 'WORKING'], ['ACTIVE', 'DAMAGED']], 'old Status values become the Condition; old ACTIVE/INACTIVE become the Status (CP164 migration rule)')
  assert.match(out[5].errors.join(' '), /Condition note is required/, 'existing note rule unchanged')
  const parsed = parseWorkbookRows(workbookXml('Equipment Template', OLD, [old('B1', 'WORKING').map(String)]), 'equipment', 'old.xlsx')   // diagnostics must not call the file "missing Condition"
  assert.equal(validateRows(parsed, 'equipment', REF)[0].valid, true)
})

function loadCommit() {
  const calls = []
  const connection = { beginTransaction: cb => cb(null), commit: cb => cb(null), rollback: cb => cb(null), release() {},
    query(sql, values, cb) { const n = sql.replace(/\s+/g, ' ').trim(); calls.push({ n, values })
      if (n.startsWith('SELECT id, laboratory_name')) return cb(null, [{ id: 1, laboratory_name: 'Lab', capacity: 40 }])
      if (n.startsWith('SELECT id, computer_name')) return cb(null, [])
      if (n.startsWith('SELECT asset_tag')) return cb(null, [])
      if (n.startsWith('SELECT category, value')) return cb(null, [{ category: 'equipment_state', value: 'Reserved' }])
      if (n.startsWith('INSERT INTO equipment')) return cb(null, { affectedRows: 1, insertId: 1 })
      throw new Error('Unexpected SQL ' + n) } }
  const inject = (file, exports) => { const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require.cache[file] = m }
  inject(path.resolve(__dirname, '../database/db.js'), { getConnection: cb => cb(null, connection) }); inject(path.resolve(__dirname, '../utils/auditLogger.js'), { logAudit() {} })
  const cp = path.resolve(__dirname, '../controllers/excelImportController.js'); delete require.cache[cp]
  return { controller: require(cp).createExcelImportController('equipment'), calls }
}
test('IMPORT SAVE (mocked DB): the imported Status is written to equipment_state, Condition to status; a missing Status saves ACTIVE', async () => {
  const { controller, calls } = loadCommit()
  const rows = [{ rowNumber: 2, data: { equipment_type: 'Projector', laboratory_id: 1, asset_tag: 'E1', serial_number: 'S1', status: 'WORKING', equipment_state: 'INACTIVE' } },
    { rowNumber: 3, data: { equipment_type: 'Projector', laboratory_id: 1, asset_tag: 'E2', serial_number: 'S2', status: 'NOT WORKING', condition_note: 'Lamp', equipment_state: 'Reserved' } },
    { rowNumber: 4, data: { equipment_type: 'Projector', laboratory_id: 1, asset_tag: 'E3', serial_number: 'S3', status: 'WORKING' } }]   // older client: no equipment_state
  const res = { code: 0, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } }
  await controller.commit({ body: { rows }, user: { id: 7 } }, res)
  assert.equal(res.code, 201, JSON.stringify(res.body))
  const ins = calls.filter(c => c.n.startsWith('INSERT INTO equipment')); assert.equal(ins.length, 3)
  assert.match(ins[0].n, /status, equipment_state, condition_note/)
  assert.deepEqual(ins.map(i => [i.values[7], i.values[8]]), [['WORKING', 'INACTIVE'], ['NOT WORKING', 'RESERVED'], ['WORKING', 'ACTIVE']])
})

test('EXPORT: Status and Condition are separate columns with the right values; the export re-imports unchanged (round trip)', () => {
  const items = [{ equipment_type: 'Projector', laboratory_id: 1, asset_tag: 'EQ-1', serial_number: 'SN-1', status: 'WORKING', equipment_state: 'ACTIVE' },
    { equipment_type: 'Monitor', laboratory_id: 1, asset_tag: 'EQ-2', serial_number: 'SN-2', status: 'NOT WORKING', condition_note: 'No signal', equipment_state: 'INACTIVE' },
    { equipment_type: 'Router', laboratory_id: 1, asset_tag: 'EQ-3', serial_number: 'SN-3', status: 'WORKING', equipment_state: 'Reserved' }]
  const res = { headers: {}, code: 200, body: null, setHeader(k, v) { this.headers[k] = v; return this }, status(c) { this.code = c; return this }, send(b) { this.body = b; return this }, json() { return this } }
  createExcelExportController('equipment')({ body: { rows: items } }, res)
  const sheet = parseXlsx(res.body).Equipment, H = sheet[0]
  assert.equal(H[H.indexOf('Status') + 1], 'Condition'); assert.ok(H.includes('Condition Note'))
  const col = (r, h) => sheet[r][H.indexOf(h)]
  assert.deepEqual([1, 2, 3].map(r => [col(r, 'Status'), col(r, 'Condition')]), [['ACTIVE', 'WORKING'], ['INACTIVE', 'NOT WORKING'], ['Reserved', 'WORKING']])
  const parsed = parseWorkbookRows(workbookXml('Equipment Template', H, sheet.slice(1)), 'equipment', 'export.xlsx')
  const out = validateRows(parsed, 'equipment', REF)
  assert.deepEqual(out.map(r => r.errors), [[], [], []]); assert.deepEqual(out.map(r => [r.data.equipment_state, r.data.status]), [['ACTIVE', 'WORKING'], ['INACTIVE', 'NOT WORKING'], ['RESERVED', 'WORKING']])
})

test('SAVE AS PDF: separate Status and Condition columns; Active / Inactive / Others and Working / Not Working appear correctly', async () => {
  const { buildEquipmentPdfHtml } = await import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/equipmentPdf.js')).href)
  const items = [{ id: 1, equipment_type: 'PROJECTOR', laboratory_id: 1, asset_tag: 'EQ-1', serial_number: 'SN-1', status: 'WORKING', equipment_state: 'ACTIVE', brand: 'Epson', model: 'X' },
    { id: 2, equipment_type: 'MONITOR', laboratory_id: 1, asset_tag: 'EQ-2', serial_number: 'SN-2', status: 'NOT WORKING', condition_note: 'No signal', equipment_state: 'INACTIVE' },
    { id: 3, equipment_type: 'ROUTER', laboratory_id: 1, asset_tag: 'EQ-3', serial_number: 'SN-3', status: 'WORKING', equipment_state: 'RESERVED' },
    { id: 4, equipment_type: 'SWITCH', laboratory_id: 1, asset_tag: 'EQ-4', serial_number: 'SN-4', status: 'WORKING' }]
  const html = buildEquipmentPdfHtml(items, { now: new Date('2026-11-14T05:00:00Z') })
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)[0]
  assert.match(head, /<th class="c-stat">Status<\/th><th class="c-stat">Condition<\/th>/); assert.equal((head.match(/<th[ >]/g) || []).length, 9)
  const rows = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][0][1].split('</tr>').filter(r => r.includes('<td'))
  const cells = r => [...r.matchAll(/<td class="c-stat">([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  assert.deepEqual(rows.map(cells).filter(c => c.length), [['Active', 'Working'], ['Inactive', 'Not Working No signal'], ['Reserved', 'Working'], ['Active', 'Working']], 'Status | Condition per row; missing state shows Active; note sits under Condition only')
  assert.match(html, /PATEROS|clms-pdf-header|pdf-title/i)
  assert.match(buildEquipmentPdfHtml([], {}), /colspan="9"/)
})

test('IMPORT PREVIEW LABELS: only the Equipment page relabels equipment_state -> "status" and status -> "condition" (other modules unchanged)', () => {
  const fs = require('node:fs'), read = f => fs.readFileSync(path.resolve(__dirname, f), 'utf8')
  const panel = read('../../client/src/components/ExcelImportPanel.jsx'), page = read('../../client/src/pages/Equipment.jsx')
  assert.match(panel, /fieldLabels = null/); assert.match(panel, /fieldLabels\?\.\[key\] \?\? key\.replaceAll\('_', ' '\)/)
  assert.match(page, /fieldLabels: \{ equipment_state: "status", status: "condition" \}/)
  for (const f of ['Computers', 'Users', 'Laboratories']) assert.doesNotMatch(read(`../../client/src/pages/${f}.jsx`), /fieldLabels/)
})
