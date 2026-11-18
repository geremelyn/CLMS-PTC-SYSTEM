// CP59 - Reports: Maintenance Computers/Equipments dropdown and column cleanup.
// SOURCE-LEVEL: page wiring and route permissions are checked by reading the source files.
// UNIT: pure helpers from client/src/utils/reportFormatting.mjs are executed for real.
// MOCKED: the report controller runs against a stubbed db.query (no MySQL, no HTTP, no browser, no Vite build).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const load = () => import('../../client/src/utils/reportFormatting.mjs')

const rows = [
  { id: 1, computer_id: 10, equipment_id: null, date_reported: '2026-11-01T09:00:00.000Z', status: 'PENDING', issue_description: 'Wont boot', laboratory_name: 'Lab 1', reported_by: 'T One', reported_by_username: '2026001', reported_by_role: 'Teacher', reported_by_program: 'BSIT', computer_name: 'PC-01', computer_asset_tag: 'CT-1', equipment_type: null, equipment_asset_tag: null },
  { id: 2, computer_id: null, equipment_id: 20, date_reported: '2026-11-02T09:00:00.000Z', status: 'COMPLETED', issue_description: 'No signal', laboratory_name: 'Lab 2', reported_by: 'T Two', reported_by_username: '2026002', reported_by_role: 'Teacher', reported_by_program: 'BSIT', computer_name: null, computer_asset_tag: null, equipment_type: 'Projector', equipment_asset_tag: 'EQ-9' },
  { id: 3, computer_id: 11, equipment_id: null, date_reported: '2026-11-03T09:00:00.000Z', status: 'IN PROGRESS', issue_description: 'Slow', laboratory_name: 'Lab 1', reported_by: 'T One', reported_by_username: '2026001', reported_by_role: 'Teacher', reported_by_program: 'BSIT', computer_name: 'PC-02', computer_asset_tag: 'CT-2', equipment_type: null, equipment_asset_tag: null }
]

test('switching kind filters records: Computers shows computer records, Equipments shows equipment records', async () => {
  const { filterMaintenanceByKind, MAINTENANCE_KINDS } = await load()
  assert.deepEqual(MAINTENANCE_KINDS, [['computers', 'Computers'], ['equipment', 'Equipments']])
  assert.deepEqual(filterMaintenanceByKind(rows, 'computers').map(r => r.id), [1, 3])
  assert.deepEqual(filterMaintenanceByKind(rows, 'equipment').map(r => r.id), [2])
  assert.equal(filterMaintenanceByKind(rows).length, 2, 'defaults to computers')
  assert.equal(rows.length, 3, 'source data is not mutated')
})

test('Computers report: no Equipment Asset Tag column (nor other equipment-only columns); computer columns kept', async () => {
  const { makeReportViewRows, filterMaintenanceByKind, displayReportColumn } = await load()
  const view = makeReportViewRows(filterMaintenanceByKind(rows, 'computers'), 'maintenance', 'computers')
  const cols = Object.keys(view[0])
  assert.ok(!cols.includes('equipment_asset_tag') && !cols.includes('equipment_type'))
  assert.ok(cols.includes('computer_name') && cols.includes('computer_asset_tag'))
  assert.ok(!cols.includes('computer_id') && !cols.includes('equipment_id') && !cols.includes('id'), 'internal ids are not displayed')
  for (const c of ['laboratory_name', 'status', 'issue_description', 'Reported By', 'Reported Date & Time']) assert.ok(cols.includes(c), c)
  assert.equal(displayReportColumn('computer_asset_tag'), 'Computer Asset Tag')
  assert.equal(view[0]['Reported By'], 'ID: 2026001 · T One · BSIT · BSIT-Teacher')
})

test('Equipments report: no Computer Asset Tag column (nor other computer-only columns); equipment columns kept', async () => {
  const { makeReportViewRows, filterMaintenanceByKind } = await load()
  const view = makeReportViewRows(filterMaintenanceByKind(rows, 'equipment'), 'maintenance', 'equipment')
  const cols = Object.keys(view[0])
  assert.ok(!cols.includes('computer_asset_tag') && !cols.includes('computer_name'))
  assert.ok(cols.includes('equipment_type') && cols.includes('equipment_asset_tag'))
  assert.ok(!cols.includes('computer_id') && !cols.includes('equipment_id'))
  assert.equal(view[0].equipment_asset_tag, 'EQ-9')
})

test('without a kind (Dean/Teacher "My Issue Reports") the maintenance columns are unchanged apart from hidden ids', async () => {
  const { makeReportViewRows } = await load()
  const cols = Object.keys(makeReportViewRows([rows[0]], 'maintenance')[0])
  for (const c of ['computer_name', 'computer_asset_tag', 'equipment_type', 'equipment_asset_tag']) assert.ok(cols.includes(c), c)
  assert.ok(!cols.includes('computer_id') && !cols.includes('equipment_id'))
})

test('existing search behaviour still works on the filtered view rows (same predicate as the page)', async () => {
  const { makeReportViewRows, filterMaintenanceByKind, formatReportValue } = await load()
  const view = makeReportViewRows(filterMaintenanceByKind(rows, 'computers'), 'maintenance', 'computers')
  const find = term => view.filter(row => Object.values(row).some(v => formatReportValue(v).toLocaleLowerCase().includes(term)))
  assert.equal(find('pc-02').length, 1); assert.equal(find('lab 1').length, 2); assert.equal(find('projector').length, 0, 'equipment records are not searchable from the Computers view')
})

test('other reports are unchanged (reservations / inventory / user accounts still format as before)', async () => {
  const { makeReportViewRows } = await load()
  assert.equal(makeReportViewRows([{ id: 4, asset_type: 'COMPUTER', asset_tag: 'T', serial_number: 'S' }], 'inventory')[0]['Asset Tag / Serial Number'], 'T / S')
  assert.equal(makeReportViewRows([{ id: 7, username: '1', role: 'Inventory Staff' }], 'user-accounts')[0].role, 'MIS Staff')
})

test('page wiring: dropdown under Maintenance with Computers/Equipments, hidden for other reports, print/export/refresh/search/pagination kept', () => {
  const src = read('../../client/src/pages/Reports.jsx')
  assert.match(src, /id="report-maintenance-kind"/); assert.match(src, /MAINTENANCE_KINDS\.map/)
  assert.match(src, /activeSelected === 'maintenance' && !isFaculty/)
  assert.match(src, /filterMaintenanceByKind\(data, maintenanceKind\)/); assert.match(src, /makeViewRows\(reportData, activeSelected, showMaintenanceKind \? maintenanceKind : \(isFaculty && activeSelected === 'maintenance' \? 'combined' : null\)\)/) // CP77: Dean/Teacher use the combined single-asset-tag view
  assert.match(src, /buildReportsPdfHtml\(title, columns, selectedCount \? selectedVisible\.map\(e => e\.row\) : filteredData/) /* CP99: Print PDF now uses the shared PTC Letter template */; assert.match(src, /Save as PDF/); assert.match(src, /refreshReport/); assert.match(src, /searchTerm/); assert.match(src, /report-pagination/); assert.match(src, /report-print-all/)
  assert.match(src, /\/reports\/\$\{activeSelected\}/, 'still uses the same maintenance report endpoint')
  assert.match(src, /\['maintenance', 'Maintenance'\]/)
})

test('Damaged Equipment is not offered on the Reports page', () => {
  const src = read('../../client/src/pages/Reports.jsx')
  assert.doesNotMatch(src, /damaged/i)
})

test('role permissions unchanged: report routes keep their role lists', () => {
  const src = read('../routes/reportRoutes.js')
  assert.match(src, /'\/maintenance', requireRole\('MIS','Inventory Staff','Dean','Teacher','Others'\)/)
  assert.match(src, /'\/inventory', requireRole\('MIS','Inventory Staff'\)/)
  assert.match(src, /'\/reservations', requireRole\('MIS','Inventory Staff'\)/)
  assert.match(src, /'\/user-accounts', requireRole\('MIS'\)/)
  const page = read('../../client/src/pages/Reports.jsx')
  assert.match(page, /const FACULTY_REPORTS = \[\['maintenance', 'My Issue Reports'\]\]/)
  assert.match(page, /const INVENTORY_REPORTS = \[\s*\['reservations', 'Reservation Reports'\],\s*\['inventory', 'Inventory'\],\s*\['maintenance', 'Maintenance'\],\s*\]/)
})

test('MOCKED db: maintenance report now returns computer_id/equipment_id, keeps lab filter and Dean/Teacher own-records scoping', async () => {
  const calls = []
  const dbPath = path.resolve(__dirname, '../database/db.js'), cPath = path.resolve(__dirname, '../controllers/reportController.js')
  const m = new Module(dbPath); m.filename = dbPath; m.loaded = true
  m.exports = { query(sql, params, cb) { calls.push({ sql: sql.replace(/\s+/g, ' '), params }); cb(null, rows) } }; require.cache[dbPath] = m
  delete require.cache[cPath]
  const { getMaintenanceReport } = require(cPath)
  const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
  let r = res(); await getMaintenanceReport({ query: {}, user: { id: 5, role: 'Teacher' } }, r)
  assert.equal(r.code, 200); assert.equal(r.body.report.length, 3)
  assert.match(calls[0].sql, /m\.computer_id, m\.equipment_id/); assert.match(calls[0].sql, /c\.asset_tag AS computer_asset_tag/); assert.match(calls[0].sql, /e\.asset_tag AS equipment_asset_tag/)
  assert.match(calls[0].sql, /AND m\.reported_by = \?/); assert.deepEqual(calls[0].params, [5])
  r = res(); await getMaintenanceReport({ query: { laboratory_id: '2' }, user: { id: 1, role: 'MIS' } }, r)
  assert.match(calls[1].sql, /COALESCE\(c\.laboratory_id, e\.laboratory_id\) = \?/); assert.ok(!/m\.reported_by = \?/.test(calls[1].sql)); assert.deepEqual(calls[1].params, [2])
})
