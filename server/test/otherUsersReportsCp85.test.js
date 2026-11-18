'use strict'
// CP85: custom-role (Others) Report Issue + My Reports + Save as PDF. OFFLINE: mocked db, pure functions, static source checks.
// No live MySQL/MariaDB and no real browser/PDF viewer was used.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const Module = require('node:module')
const root = path.join(__dirname, '..', '..'), client = path.join(root, 'client', 'src')
const stub = (rel, exports) => { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
const load = rel => { const p = path.resolve(__dirname, rel); delete require.cache[p]; return require(p) }
const reply = () => new Promise(resolve => { const r = { code: 200, status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }); return this } }; resolve.r = r; })
const call = (fn, req) => new Promise(resolve => { const r = { code: 200, status(c) { this.code = c; return this }, json(b) { resolve({ code: this.code, body: b }) } }; Promise.resolve(fn(req, r)) })

test('privacy: custom role / Dean / Teacher maintenance report is filtered to their OWN id; MIS and MIS Staff are not', async () => {
  const seen = []
  stub('../database/db.js', { query(sql, params, cb) { seen.push({ sql: sql.replace(/\s+/g, ' '), params }); cb(null, []) } })
  const { getMaintenanceReport } = load('../controllers/reportController.js')
  for (const role of ['Others', 'Teacher', 'Dean']) {
    seen.length = 0; const out = await call(getMaintenanceReport, { user: { id: 77, role }, query: {} })
    assert.equal(out.code, 200); assert.match(seen[0].sql, /AND m\.reported_by = \?/); assert.deepEqual(seen[0].params, [77])
  }
  for (const role of ['MIS', 'Inventory Staff']) { seen.length = 0; await call(getMaintenanceReport, { user: { id: 1, role }, query: {} }); assert.doesNotMatch(seen[0].sql, /m\.reported_by = \?/); assert.deepEqual(seen[0].params, []) }
  // a query-string attempt to widen the report (another user's id) is ignored: the filter is always the session user
  seen.length = 0; await call(getMaintenanceReport, { user: { id: 77, role: 'Others' }, query: { reported_by: '5', user_id: '5' } })
  assert.deepEqual(seen[0].params, [77])
})
test('report rows carry status, submission date, issue detail and the custom role name', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'reportController.js'), 'utf8')
  assert.match(sql, /m\.date_reported, m\.date_resolved, m\.status, m\.issue_description, m\.maintenance_note/)
  assert.match(sql, /u\.role_other AS reported_by_role_other/)
  const { makeReportViewRows } = await import(path.join(client, 'utils', 'reportFormatting.mjs'))
  const rows = makeReportViewRows([{ id: 4, computer_id: 2, date_reported: '2026-11-09T08:00:00.000Z', status: 'IN PROGRESS', issue_description: 'No display', reported_by: 'Lia Tan', reported_by_username: 'u9', reported_by_role: 'Others', reported_by_role_other: 'Laboratory Assistant' }], 'maintenance', 'combined')
  assert.equal(rows[0].status, 'IN PROGRESS'); assert.match(rows[0]['Reported Date & Time'], /2026-11-09/); assert.match(rows[0]['Reported By'], /Laboratory Assistant/); assert.ok(!('id' in rows[0]))
})
test('submission: a custom role report is stored against the SESSION user, never a user id from the request body (mocked db)', async () => {
  const inserts = []
  stub('../database/db.js', { query(sql, params, cb) { const n = sql.replace(/\s+/g, ' '); if (/FROM computers WHERE id/.test(n)) return cb(null, [{ id: 3, laboratory_id: 2, computer_name: 'PC-3', asset_tag: 'A' }]); if (/^INSERT INTO maintenance/.test(n.trim())) { inserts.push(params); return cb(null, { insertId: 11 }) } cb(null, []) } })
  stub('../utils/auditLogger.js', { logAudit() {} })
  const { createMaintenance } = load('../controllers/maintenanceController.js')
  const out = await call(createMaintenance, { user: { id: 77, role: 'Others' }, body: { laboratory_id: 2, computer_id: 3, issue_description: 'Screen flickers', reported_by: 1 } })
  assert.equal(out.code, 201); assert.equal(out.body.maintenance.reported_by, 77); assert.equal(out.body.maintenance.status, 'PENDING'); assert.deepEqual(inserts[0], [3, null, 77, 'Screen flickers'])
})
test('route permissions: custom roles can submit + read OWN maintenance reports only; every other report endpoint and all management routes stay closed', () => {
  const stubRole = { requireRole: (...roles) => Object.assign(() => {}, { roles }) }
  stub('../middleware/roleAuth.js', stubRole)
  const get = file => { const p = path.resolve(__dirname, '../routes', file); delete require.cache[p]; const r = require(p); return r.stack.map(l => ({ key: `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`, roles: l.route.stack.flatMap(h => h.roles || []) })) }
  const reports = get('reportRoutes.js'), maint = get('maintenanceRoutes.js')
  assert.deepEqual(reports.filter(r => r.roles.includes('Others')).map(r => r.key), ['GET /maintenance'])
  assert.deepEqual(maint.filter(r => r.roles.includes('Others')).map(r => r.key), ['POST /'])
  for (const r of maint.filter(r => r.key !== 'POST /')) assert.ok(!r.roles.includes('Others'), r.key) // list / update / delete maintenance stay MIS + MIS Staff
  assert.deepEqual(maint.find(r => r.key === 'GET /').roles, ['MIS', 'Inventory Staff'])
  assert.deepEqual(reports.find(r => r.key === 'GET /reservations').roles, ['MIS', 'Inventory Staff']); assert.deepEqual(reports.find(r => r.key === 'GET /user-accounts').roles, ['MIS'])
  assert.deepEqual(maint.find(r => r.key === 'POST /').roles, ['Teacher', 'Dean', 'Others'])
})
test('PDF: official PTC header (logo, school, address, IICT), own rows only, readable fields, HTML-escaped', async () => {
  const { buildMyReportsPdfHtml, myReportRow, canSaveMyReportsPdf } = await import(path.join(client, 'utils', 'myReportsPdf.js'))
  const html = buildMyReportsPdfHtml([{ date_reported: '2026-11-09T08:30:00.000Z', computer_name: 'PC-01', laboratory_name: 'Lab 1', issue_description: 'Won\'t boot <script>x</script>', status: 'PENDING', date_resolved: null, maintenance_note: null }, { date_reported: '2026-11-08T01:00:00.000Z', equipment_type: 'Projector', laboratory_name: 'Lab 2', issue_description: 'No signal', status: 'COMPLETED', date_resolved: '2026-11-09T02:00:00.000Z', maintenance_note: 'Cable replaced' }], { owner: 'Lia Tan', logoBase: 'http://x', now: new Date('2026-11-09T09:00:00Z') })
  for (const needle of ['/clms-logo.png', 'PATEROS TECHNOLOGICAL COLLEGE', 'College St., Sto. Rosario Kanluran, Pateros, Metro Manila', 'Institute of Information and Computing Technology', 'MY REPORTS', 'Submitted by: Lia Tan', 'Total reports: 2', 'Computer: PC-01', 'Equipment: Projector', 'PENDING', 'COMPLETED', 'Cable replaced', '@page { size: 8.5in 11in']) assert.ok(html.includes(needle), needle)
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'))
  assert.match(buildMyReportsPdfHtml([], {}), /You have not submitted any reports/)
  assert.equal(myReportRow({ status: null }).status, '—'); assert.equal(canSaveMyReportsPdf('Others'), true); assert.equal(canSaveMyReportsPdf('MIS'), false)
})
test('frontend: menu, route access, Report Issue guard and Save as PDF are wired for custom roles only', () => {
  const read = (...p) => fs.readFileSync(path.join(client, ...p), 'utf8')
  const layout = read('components', 'AppLayout.jsx')
  assert.match(layout, /\['report', 'Report Issue', '\/report-issue'\],\n    \['reports', 'My Reports', '\/reports'\],\n    \['password', 'Change Password', '\/change-password'\],\n  \],\n  'Inventory Staff'/)
  const ri = read('pages', 'ReportIssue.jsx'); assert.match(ri, /isCustomRole = user\?\.role === 'Others'/); assert.equal((ri.match(/!isTeacher && !isDean && !isCustomRole/g) || []).length, 2)
  const rp = read('pages', 'Reports.jsx')
  assert.match(rp, /user\?\.role === 'Others' \/\/ each sees ONLY their own reports/); assert.match(rp, /isCustomRole \? <button type="button" onClick=\{saveMyReportsPdf\}[^>]*>Save as PDF<\/button> : <>\{facultyActions\}<button type="button" onClick=\{printReport\}>Save as PDF<\/button><\/>/)
  assert.match(rp, /const FACULTY_REPORTS = \[\['maintenance', 'My Issue Reports'\]\]/) // custom roles get only the own-reports tab
  assert.match(rp, /const options = useMemo\(\(\) => isMIS \? MIS_REPORTS : isInventory \? INVENTORY_REPORTS : FACULTY_REPORTS/)
})
