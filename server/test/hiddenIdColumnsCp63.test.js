'use strict'
// CP63: internal database IDs must not be shown as table columns, but must stay in API data, state and row keys.
// Static source checks + pure-function tests (no database, no browser).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const client = path.join(__dirname, '..', '..', 'client', 'src')
const server = path.join(__dirname, '..')
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
const uiFiles = [...walk(path.join(client, 'pages')), ...walk(path.join(client, 'components')), ...walk(path.join(client, 'utils'))].filter(f => /\.(jsx|js|mjs)$/.test(f))

test('no table header is a bare internal ID column (school "ID Number" is allowed)', () => {
  const offenders = []
  for (const file of uiFiles) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/<th[^>]*>\s*([^<{]*)</g)) {
      const label = m[1].replace(/&amp;/g, '&').trim()
      if (/^(id|#|(user|laboratory|lab|computer|equipment|reservation|record|maintenance) id)$/i.test(label)) offenders.push(`${path.basename(file)}: ${label}`)
    }
  }
  assert.deepEqual(offenders, [])
})
test('no table cell renders a raw internal id', () => {
  const offenders = []
  for (const file of uiFiles) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/<td[^>]*>\s*\{\s*[A-Za-z_]+\.(id|entity_id|laboratory_id|computer_id|equipment_id)\s*\}\s*<\/td>/g)) offenders.push(`${path.basename(file)}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [])
})
test('report view hides ids from columns but never mutates the source rows', async () => {
  const { makeReportViewRows } = await import(path.join(client, 'utils', 'reportFormatting.mjs'))
  const maint = [{ id: 7, computer_id: 3, equipment_id: null, status: 'OPEN', reported_by: 'A', reported_by_username: 'u1' }]
  const view = makeReportViewRows(maint, 'maintenance', 'computers')
  for (const key of ['id', 'computer_id', 'equipment_id']) assert.ok(!(key in view[0]), `${key} hidden`)
  assert.equal(maint[0].id, 7); assert.equal(maint[0].computer_id, 3)
  const res = [{ id: 9, laboratory_name: 'L', reservation_date: '2026-11-09', start_time: '08:00', end_time: '09:00', status: 'APPROVED' }]
  assert.ok(!('id' in makeReportViewRows(res, 'reservations')[0])); assert.equal(res[0].id, 9)
})
test('APIs and exports still return ids; selection and CRUD still key on ids', () => {
  const read = f => fs.readFileSync(f, 'utf8')
  assert.match(read(path.join(server, 'controllers', 'userController.js')), /SELECT id, full_name/)
  assert.match(read(path.join(server, 'controllers', 'laboratoryController.js')), /SELECT \* FROM laboratories/)
  assert.match(read(path.join(server, 'controllers', 'computerController.js')), /SELECT \* FROM computers/)
  assert.match(read(path.join(server, 'controllers', 'reportController.js')), /SELECT r\.id, l\.laboratory_name/)
  assert.match(read(path.join(client, 'pages', 'Users.jsx')), /selectedUserIds\.includes\(u\.id\)/)
  assert.match(read(path.join(client, 'pages', 'Laboratories.jsx')), /selectedLabIds\.includes\(Number\(lab\.id\)\)/)
  assert.match(read(path.join(client, 'pages', 'Computers.jsx')), /selectedComputerIds\.includes\(Number\(c\.id\)\)/)
  assert.match(read(path.join(client, 'pages', 'Laboratories.jsx')), /key=\{lab\.id\}/)
})
