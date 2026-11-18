// CP77 - Dean/Teacher navigation + Reports columns audit.
// SOURCE-LEVEL: AppLayout/App/route files are read as text. UNIT: pure report helper runs for real.
// Not covered: real browser rendering, real MySQL.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const load = () => import('../../client/src/utils/reportFormatting.mjs')
const layout = read('../../client/src/components/AppLayout.jsx')
const block = (name, next) => layout.slice(layout.indexOf(`  ${name}: [`), layout.indexOf(next))

test('Dean/Teacher sidebars have no Maintenance dropdown or Computers/Equipments pages (permissions preserved)', () => {
  for (const [name, next] of [['Teacher', '  Dean: ['], ['Dean', '  // Custom-role']]) {
    const b = block(name, next)
    assert.ok(b.includes("'/reports'") && b.includes("'/report-issue'"), `${name} keeps Report Issue + Reports`)
    assert.doesNotMatch(b, /maintenance|\/computers|\/equipment/)
  }
  const access = layout.match(/ROUTE_ACCESS = \{[\s\S]*?\n\}/)[0]
  for (const role of ['Teacher', 'Dean']) {
    const line = access.split('\n').find(l => l.trim().startsWith(`${role}:`))
    assert.doesNotMatch(line, /\/maintenance|\/computers|\/equipment/)
  }
})

test('Maintenance and asset pages exist and stay MIS / MIS Staff for management; Dean/Teacher only file issues', () => {
  const app = read('../../client/src/App.jsx')
  for (const p of ['/maintenance', '/maintenance-history', '/computers', '/equipment']) assert.ok(app.includes(`path="${p}"`))
  const m = read('../routes/maintenanceRoutes.js')
  assert.match(m, /router\.get\('\/', requireRole\('MIS','Inventory Staff'\)/)
  assert.match(m, /router\.post\('\/', requireRole\('Teacher','Dean','Others'\)/) // CP85: + custom roles
  assert.match(read('../routes/reportRoutes.js'), /'\/maintenance', requireRole\('MIS','Inventory Staff','Dean','Teacher','Others'\)/)
})

const mixed = [
  { id: 1, computer_id: 10, equipment_id: null, date_reported: '2026-11-01T09:00:00.000Z', status: 'PENDING', laboratory_name: 'Lab 1', reported_by: 'T One', reported_by_role: 'Teacher', computer_name: 'PC-01', computer_asset_tag: 'AT-PC-01', equipment_type: null, equipment_asset_tag: null },
  { id: 2, computer_id: null, equipment_id: 20, date_reported: '2026-11-02T09:00:00.000Z', status: 'COMPLETED', laboratory_name: 'Lab 2', reported_by: 'T One', reported_by_role: 'Teacher', computer_name: null, computer_asset_tag: null, equipment_type: 'PROJECTOR', equipment_asset_tag: 'AT-PJ-01' },
]

test('Dean/Teacher My Issue Reports: one Asset Tag column, no duplicate/blank tag columns', async () => {
  const { makeReportViewRows } = await load()
  const out = makeReportViewRows(mixed, 'maintenance', 'combined')
  for (const r of out) {
    const keys = Object.keys(r)
    assert.equal(keys.filter(k => /asset.?tag/i.test(k)).length, 1)
    for (const gone of ['computer_asset_tag', 'equipment_asset_tag', 'computer_name', 'equipment_type', 'computer_id', 'equipment_id']) assert.ok(!(gone in r))
  }
  assert.deepEqual([out[0]['Asset Type'], out[0]['Asset Name'], out[0]['Asset Tag']], ['Computer', 'PC-01', 'AT-PC-01'])
  assert.deepEqual([out[1]['Asset Type'], out[1]['Asset Name'], out[1]['Asset Tag']], ['Equipment', 'PROJECTOR', 'AT-PJ-01'])
  assert.equal(mixed[0].computer_asset_tag, 'AT-PC-01', 'source not mutated')
})

test('MIS / MIS Staff Maintenance report columns unchanged; Reports.jsx wires combined only for Dean/Teacher', async () => {
  const { makeReportViewRows } = await load()
  const c = makeReportViewRows(mixed, 'maintenance', 'computers')[0]
  assert.ok('computer_asset_tag' in c && !('equipment_asset_tag' in c) && !('Asset Tag' in c))
  const e = makeReportViewRows(mixed, 'maintenance', 'equipment')[1]
  assert.ok('equipment_asset_tag' in e && !('computer_asset_tag' in e))
  assert.match(read('../../client/src/pages/Reports.jsx'), /isFaculty && activeSelected === 'maintenance' \? 'combined'/)
})
