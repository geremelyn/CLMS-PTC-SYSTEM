const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
// Reads the real route files and records which roles each route allows.
function rolesByRoute(file) {
  const order = []
  const rp = path.resolve(__dirname, '../middleware/roleAuth.js'); const m = new Module(rp); m.filename = rp; m.loaded = true
  m.exports = { requireRole: (...roles) => { order.push(roles); return (q, s, n) => n() } }; require.cache[rp] = m
  const routes = path.resolve(__dirname, `../routes/${file}.js`); delete require.cache[routes]
  const router = require(routes), out = {}
  router.stack.filter(l => l.route).forEach((layer, i) => { out[`${Object.keys(layer.route.methods)[0]} ${layer.route.path}`] = order[i] })
  delete require.cache[rp]; return out
}
test('Computers: MIS Staff (Inventory Staff) may view, export, add, edit and delete (single + bulk); Excel import is MIS + MIS Staff', () => {
  const r = rolesByRoute('computerRoutes')
  assert.ok(r['get /'].includes('Inventory Staff')); assert.ok(r['post /export'].includes('Inventory Staff'))
  for (const key of ['post /', 'post /quick', 'put /:id', 'delete /:id', 'post /bulk-delete', 'post /undo-bulk-delete/:undoId']) assert.deepEqual(r[key], ['MIS', 'Inventory Staff'], key)
  for (const key of ['post /import', 'post /import-preview']) assert.deepEqual(r[key], ['MIS', 'Inventory Staff'], key)
  for (const roles of Object.entries(r).filter(([k]) => !k.startsWith('get ') && !k.startsWith('post /export')).map(([, v]) => v)) assert.ok(!roles.some(role => ['Teacher', 'Dean'].includes(role)))
})
test('Reports: MIS Staff may read Reservation Reports; Dean/Teacher still cannot; User Accounts / Audit stay MIS-only', () => {
  const r = rolesByRoute('reportRoutes')
  assert.deepEqual(r['get /reservations'], ['MIS', 'Inventory Staff'])
  assert.deepEqual(r['get /user-accounts'], ['MIS']); assert.deepEqual(r['get /audit-log'], ['MIS'])
  assert.ok(!r['get /reservations'].some(role => ['Teacher', 'Dean'].includes(role)))
})
test('Equipment: MIS Staff keeps its existing add/import/delete/export rights; roles are exactly MIS + Inventory Staff for changes', () => {
  const r = rolesByRoute('equipmentRoutes')
  for (const key of ['post /', 'put /:id', 'delete /:id', 'post /bulk-delete', 'post /undo-bulk-delete/:undoId', 'post /import', 'post /import-preview']) assert.deepEqual(r[key], ['MIS', 'Inventory Staff'], key)
  assert.ok(!r['post /bulk-delete'].some(role => ['Teacher', 'Dean'].includes(role)))
})
test('Users / Laboratories management and Recycle Bin are never open to MIS Staff, Dean or Teacher for changes (only the laboratory list is readable by all)', () => {
  for (const file of ['userRoutes', 'laboratoryRoutes', 'recycleBinRoutes', 'undoRoutes']) {
    const r = rolesByRoute(file)
    for (const [key, roles] of Object.entries(r)) { if (key.startsWith('get ') && file === 'laboratoryRoutes') continue /* everyone reads the lab list for booking */; if (file === 'userRoutes' && key.includes('change-password')) continue; assert.ok(!roles.some(role => ['Inventory Staff', 'Dean', 'Teacher'].includes(role)), `${file} ${key}`) }
  }
})
