// CP46 STATIC test: parses routes/reservationRoutes.js (no express needed, no database, no HTTP).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const src = fs.readFileSync(path.resolve(__dirname, '../routes/reservationRoutes.js'), 'utf8')
const roles = {}
for (const m of src.matchAll(/router\.(get|post|put)\('([^']+)',\s*requireRole\(([^)]*)\)/g)) roles[`${m[1]} ${m[2]}`] = m[3].split(',').map(x => x.trim().replace(/'/g, '')).sort()
const sorted = (...r) => [...r].sort()
test('MIS Staff (Inventory Staff) may view and decide reservations but never create, cancel or delete them', () => {
  assert.ok(roles['get /'].includes('Inventory Staff'))
  assert.deepEqual(roles['put /:id/decision'], sorted('MIS', 'Inventory Staff'))
  assert.deepEqual(roles['put /:id/undo-decision'], sorted('MIS', 'Inventory Staff'))
  for (const key of ['post /', 'get /availability', 'put /:id/cancel', 'put /:id/cancel-own', 'put /:id/undo-cancel', 'put /:id/undo-create', 'post /bulk-delete']) assert.ok(!roles[key].includes('Inventory Staff'), key)
})
test('Dean and Teacher may submit and cancel, but cannot decide or bulk-delete', () => {
  for (const key of ['post /', 'put /:id/cancel', 'put /:id/undo-create']) assert.ok(roles[key].includes('Dean') && roles[key].includes('Teacher'), key)
  for (const key of ['put /:id/decision', 'put /:id/undo-decision', 'post /bulk-delete']) assert.ok(!roles[key].includes('Dean') && !roles[key].includes('Teacher'), key)
  assert.deepEqual(roles['post /bulk-delete'], ['MIS'])
})
