// CP70: role matrix of the client File Actions helper (pure function, no DOM, no database, no HTTP).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/fileActions.js')).href)
const keys = (items) => items.map(item => item.key)
// The File Actions menu no longer has a "Download Template" item (client/src/utils/fileActions.js + FileActionsMenu.jsx list Import / Export / Save as PDF only).
// The role matrix is unchanged; the server import-template routes and TEMPLATE_ENDPOINTS still exist and are still asserted below.
const ALL = ['import', 'export', 'pdf']

test('Users and Laboratories: only Super Admin (MIS) gets any action', async () => {
  const { getFileActions } = await load()
  for (const module of ['users', 'laboratories']) {
    assert.deepEqual(keys(getFileActions(module, 'MIS', { pdf: true })), ALL, module)
    for (const role of ['Inventory Staff', 'Teacher', 'Dean', 'Others']) assert.deepEqual(getFileActions(module, role, { pdf: false }), [], `${module}/${role}`)
  }
})
test('Computers and Equipment: Super Admin and MIS Staff get all three; other roles get none', async () => {
  const { getFileActions } = await load()
  for (const module of ['computers', 'equipment']) {
    for (const role of ['MIS', 'Inventory Staff']) assert.deepEqual(keys(getFileActions(module, role, { pdf: true })), ALL, `${module}/${role}`)
    for (const role of ['Teacher', 'Dean', 'Others']) assert.deepEqual(getFileActions(module, role, { pdf: false }), [], `${module}/${role}`)
  }
})
test('Save as PDF follows the page\'s own predicate and never appears when it is false; unknown modules show nothing', async () => {
  const { getFileActions } = await load()
  assert.deepEqual(keys(getFileActions('computers', 'MIS', { pdf: false })), ['import', 'export'])
  assert.deepEqual(keys(getFileActions('equipment', 'Teacher', { pdf: true })), ['pdf'])
  assert.deepEqual(getFileActions('reservations', 'MIS', { pdf: false }), [])
})
test('template endpoints are the existing server routes, and each is registered with the matching roles', async () => {
  const { TEMPLATE_ENDPOINTS } = await load(); const fs = require('node:fs')
  assert.deepEqual(TEMPLATE_ENDPOINTS, { users: '/users/import-template', laboratories: '/laboratories/import-template', computers: '/computers/import-template', equipment: '/equipment/import-template' })
  const roles = { users: "requireRole('MIS')", laboratories: "requireRole('MIS')", computers: "requireRole('MIS','Inventory Staff')", equipment: "requireRole('MIS','Inventory Staff')" }
  const files = { users: 'userRoutes.js', laboratories: 'laboratoryRoutes.js', computers: 'computerRoutes.js', equipment: 'equipmentRoutes.js' }
  for (const module of Object.keys(files)) assert.ok(fs.readFileSync(path.resolve(__dirname, '../routes', files[module]), 'utf8').includes(`router.get('/import-template', ${roles[module]}`), module)
})
