'use strict'
// CP174 Part 4: Laboratories route permissions (stub express + stub controllers; not MySQL).
// Project rule (CP38/CP93/CHANGELOG): Laboratories management, import, export, bulk delete and Save as PDF are Super Admin (MIS) only;
// MIS Staff ('Inventory Staff') may only READ the list (dropdowns elsewhere) and cannot open the Laboratories page.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }

test('Laboratories routes: read for the listed roles, every write/import/export/delete route is MIS only', () => {
  const registered = []
  const reg = method => (...a) => registered.push({ method, path: a[0], roles: a[1] && a[1].roles })
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') }
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => Object.assign(() => {}, { roles }) })
  const noop = () => {}
  stub('../controllers/laboratoryController.js', { createLaboratory: noop, getLaboratories: noop, updateLaboratory: noop })
  stub('../controllers/simpleImportController.js', { createSimpleImportController: () => ({ preview: noop, commit: noop }) })
  stub('../controllers/importTemplateController.js', { createImportTemplateController: () => noop })
  stub('../controllers/dataExportController.js', { createDataExportController: () => noop })
  stub('../controllers/recycleBinController.js', { deleteLaboratories: noop })
  stub('../utils/updateUndo.js', { withUpdateUndo: () => noop })
  const expressPath = require.resolve('express'); const original = require.cache[expressPath]
  stub(expressPath, Object.assign(() => ({}), { Router: () => router }))
  try { delete require.cache[path.resolve(__dirname, '../routes/laboratoryRoutes.js')]; require('../routes/laboratoryRoutes.js') } finally { if (original) require.cache[expressPath] = original; else delete require.cache[expressPath] }
  const find = (method, p) => registered.find(r => r.method === method && r.path === p)
  assert.deepEqual([...find('GET', '/').roles].sort(), ['Dean', 'Inventory Staff', 'MIS', 'Others', 'Teacher'])
  for (const [method, p] of [['GET', '/import-template'], ['POST', '/import-preview'], ['POST', '/import'], ['POST', '/export'], ['POST', '/bulk-delete'], ['POST', '/'], ['PUT', '/:id'], ['DELETE', '/:id']]) {
    const route = find(method, p); assert.ok(route, `${method} ${p} registered`); assert.deepEqual(route.roles, ['MIS'], `${method} ${p} is MIS only`)
  }
  assert.equal(registered.length, 9, 'no unexpected Laboratories routes')
})

test('client: only MIS gets Save as PDF; MIS Staff gets no Laboratories file actions', async () => {
  const fs = require('node:fs'); const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/utils/laboratoriesPdf.js'), 'utf8')
  assert.match(src, /canSaveLaboratoriesPdf\(role\)\s*\{\s*return role === 'MIS'/)
})
