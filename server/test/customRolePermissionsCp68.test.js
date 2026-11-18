'use strict'
// CP68: custom roles (stored as role 'Others' + role_other label) get Teacher-style LAB RESERVATION access only.
// MOCKED db / route recorder. No real MySQL, no browser. The route test records every requireRole(...) call in every route file.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }

const ALLOWED = new Set([
  'reservationRoutes.js GET /', 'reservationRoutes.js GET /availability', 'reservationRoutes.js POST /', 'reservationRoutes.js PUT /:id/undo-create',
  'reservationRoutes.js PUT /:id/cancel', 'reservationRoutes.js PUT /:id/cancel-own', 'reservationRoutes.js PUT /:id/undo-cancel',
  'laboratoryRoutes.js GET /', 'holidayRoutes.js GET /',
  // CP85: Report Issue + My Reports (own reports only, enforced in reportController)
  'maintenanceRoutes.js POST /', 'reportRoutes.js GET /maintenance', 'computerRoutes.js GET /', 'equipmentRoutes.js GET /', 'userRoutes.js PUT /:id/change-password', 'authRoutes.js POST /logout',
  // CP123: custom roles upload/list/download their OWN teacher schedules only (own-only is enforced in teacherScheduleController)
  'teacherScheduleRoutes.js GET /', 'teacherScheduleRoutes.js POST /', 'teacherScheduleRoutes.js GET /:id/download',
  // CP128 (delete) and the CP122/CP123 inline view: same own-only Teacher Schedule access; own-only is enforced in teacherScheduleController (other people's schedules answer 404).
  'teacherScheduleRoutes.js GET /:id/view', 'teacherScheduleRoutes.js DELETE /:id',
  // CP162: uploader-only Undo of a fresh upload (same roles as upload; uploader-only is enforced in teacherScheduleController).
  'teacherScheduleRoutes.js POST /:id/undo-upload'
])
function recordRoutes() {
  const out = []
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => Object.assign(() => {}, { roles }) })
  const dir = path.resolve(__dirname, '../routes')
  for (const file of fs.readdirSync(dir)) {
    const p = path.join(dir, file); delete require.cache[p]
    let router; try { router = require(p) } catch (error) { assert.fail(`${file} failed to load: ${error.message}`) }
    for (const layer of router.stack || []) {
      const [m] = Object.keys(layer.route.methods)
      const roles = layer.route.stack.flatMap(h => h.roles || [])
      out.push({ key: `${file} ${m.toUpperCase()} ${layer.route.path}`, roles })
    }
  }
  return out
}
test('a custom role is authorised ONLY on the lab-reservation / self-service routes; every admin, inventory, report and maintenance route rejects it', () => {
  const routes = recordRoutes()
  assert.ok(routes.length > 60)
  const withOthers = routes.filter(r => r.roles.includes('Others')).map(r => r.key)
  assert.deepEqual(new Set(withOthers), ALLOWED)
  for (const r of routes) if (/^(user|computer|equipment|maintenance|report|recycleBin|auditLog|lookupOption|dashboard|undo)/.test(r.key) && !/change-password/.test(r.key) && !ALLOWED.has(r.key)) assert.ok(!r.roles.includes('Others'), `custom role must not reach ${r.key}`)
  // decide/approve stays MIS + MIS Staff only
  for (const r of routes.filter(r => /decision/.test(r.key))) assert.deepEqual(r.roles.sort(), ['Inventory Staff', 'MIS'])
})
test('existing MIS, MIS Staff, Dean and Teacher route permissions are unchanged (Others is the only addition)', () => {
  const routes = recordRoutes()
  const without = r => r.roles.filter(x => x !== 'Others')
  const get = key => without(routes.find(r => r.key === key))
  assert.deepEqual(get('reservationRoutes.js GET /'), ['MIS', 'Dean', 'Teacher', 'Inventory Staff'])
  assert.deepEqual(get('reservationRoutes.js POST /'), ['MIS', 'Dean', 'Teacher'])
  assert.deepEqual(get('reservationRoutes.js PUT /:id/cancel-own'), ['Dean', 'Teacher'])
  assert.deepEqual(get('laboratoryRoutes.js GET /'), ['MIS', 'Dean', 'Teacher', 'Inventory Staff'])
  assert.deepEqual(get('computerRoutes.js GET /'), ['MIS', 'Inventory Staff', 'Teacher', 'Dean'])
  assert.deepEqual(get('userRoutes.js GET /'), ['MIS'])
})
test('real requireRole middleware: an ACTIVE Others user is 403 on admin routes and passes on reservation routes (mocked db)', async () => {
  stub('../utils/sessionToken.js', { verifySessionToken: () => ({ userId: 5 }), tokenHash: () => 'h' })
  stub('../database/db.js', { query(sql, params, cb) { if (/session_revocations/.test(sql)) return cb(null, []); cb(null, [{ id: 5, full_name: 'L B', username: 'lb', role: 'Others', status: 'ACTIVE' }]) } })
  const p = path.resolve(__dirname, '../middleware/roleAuth.js'); delete require.cache[p]
  const { requireRole } = require(p)
  const call = roles => new Promise(resolve => { const res = { status(c) { this.code = c; return this }, json() { resolve({ code: this.code }) } }; requireRole(...roles)({ header: () => 'Bearer x' }, res, () => resolve({ code: 'next' })) })
  assert.equal((await call(['MIS'])).code, 403); assert.equal((await call(['MIS', 'Inventory Staff'])).code, 403); assert.equal((await call(['MIS', 'Inventory Staff', 'Teacher', 'Dean'])).code, 403)
  assert.equal((await call(['MIS', 'Dean', 'Teacher', 'Others'])).code, 'next')
})
test('reservation list for a custom role is scoped to its OWN reservations (never the all-reservations MIS branch)', async () => {
  const seen = []
  stub('../database/db.js', { query(sql, params, cb) { const n = String(sql).replace(/\s+/g, ' '); seen.push({ n, params }); cb(null, []) } })
  stub('../utils/auditLogger.js', { logAudit() {} })
  const p = path.resolve(__dirname, '../controllers/reservationController.js'); delete require.cache[p]
  const { getReservations } = require(p)
  const res = () => ({ status() { return this }, json() { } })
  await new Promise(r => { getReservations({ user: { id: 5, role: 'Others' } }, Object.assign(res(), { json() { r() } })); setTimeout(r, 100) })
  const list = seen.find(c => /FROM reservations LEFT JOIN laboratories/.test(c.n))
  assert.ok(list, 'list query ran'); assert.match(list.n, /WHERE reservations\.reserved_by = \?/); assert.deepEqual(list.params, [5])
})
test('a newly created custom role is stored as Others with its label (no Teacher/Dean/MIS role, no program)', () => {
  const { validateManagedUser } = require('../utils/userValidation.js')
  const v = validateManagedUser({ surname: 'Reyes', first_name: 'Ana', username: 'areyes', password: 'secret1', role: 'Others', role_other: 'Librarian', program: 'BSIT' }, { passwordRequired: true })
  assert.equal(v.error, null); assert.equal(v.values.role, 'Others'); assert.equal(v.values.role_other, 'Librarian'); assert.equal(v.values.program, null)
})
test('frontend: custom roles land on the Teacher dashboard and are limited to reservation pages', async () => {
  const client = path.join(__dirname, '..', '..', 'client', 'src')
  const { getDefaultDashboard } = await import(path.join(client, 'utils', 'dashboardRoutes.js'))
  assert.equal(getDefaultDashboard('Others', 'Librarian'), '/teacher-dashboard'); assert.equal(getDefaultDashboard('Others', 'Anything New'), '/teacher-dashboard')
  assert.equal(getDefaultDashboard('Teacher'), '/teacher-dashboard'); assert.equal(getDefaultDashboard('Dean'), '/dean-dashboard'); assert.equal(getDefaultDashboard('MIS'), '/mis-dashboard'); assert.equal(getDefaultDashboard('Inventory Staff'), '/inventory-dashboard')
  const layout = fs.readFileSync(path.join(client, 'components', 'AppLayout.jsx'), 'utf8')
  assert.match(layout, /Others: \['\/teacher-dashboard','\/reservations','\/my-reservations','\/teacher-schedules','\/report-issue','\/reports','\/change-password'\]/) // CP85 adds Report Issue + My Reports; CP123 adds own-only My Schedule
  const menu = layout.slice(layout.indexOf('  Others: ['), layout.indexOf("'Inventory Staff': [", layout.indexOf('  Others: [')))
  for (const forbidden of ['/users', '/computers', '/equipment', '/maintenance', '/laboratories', '/audit-log', '/recycle-bin', '/holidays']) assert.ok(!menu.includes(`'${forbidden}'`), forbidden)
  assert.match(fs.readFileSync(path.join(client, 'pages', 'TeacherDashboard.jsx'), 'utf8'), /\['Teacher', 'Others'\]\.includes\(user\?\.role\)/)
})
