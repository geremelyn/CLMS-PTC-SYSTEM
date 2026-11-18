'use strict'
// CP67: static source checks only (no browser). Visible Refresh buttons are gone; loading, CRUD reloads and Try Again remain.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const page = name => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', name), 'utf8')
// CP89: the Super Admin/MIS Head Audit Log deliberately has a Refresh button again (explicit request), so it is no longer in this list.
const REMOVED = ['Equipment', 'Computers', 'Holidays', 'RecycleBin', 'Reports', 'MyReservations', 'Reservations']

test('no visible manual Refresh button remains on the eight pages', () => {
  for (const name of REMOVED) assert.doesNotMatch(page(`${name}.jsx`), /<button[^>]*>\s*Refresh\s*<\/button>/, name)
})
test('automatic loading on page open is intact', () => {
  assert.match(page('AuditLog.jsx'), /loadLogs\(\)/); assert.match(page('RecycleBin.jsx'), /useEffect\(\(\) => \{ load\(\) \}, \[load\]\)/)
  assert.match(page('Holidays.jsx'), /Promise\.resolve\(\)\.then\(load\)/); assert.match(page('Computers.jsx'), /useEffect\(/); assert.match(page('Equipment.jsx'), /useEffect\(/)
  assert.match(page('MyReservations.jsx'), /useEffect\(/); assert.match(page('Reports.jsx'), /useEffect\(/)
})
test('reload-after-action and Try Again paths are intact; refresh helpers were not deleted', () => {
  assert.match(page('Equipment.jsx'), /setSelectedEquipmentIds\(\[\]\)\n\s*await loadAll\(\)/)
  assert.match(page('Computers.jsx'), /getComputers\(\)/); assert.match(page('Holidays.jsx'), /Try Again/)
  assert.match(page('Reports.jsx'), /function refreshReport\(\)/); assert.match(page('Reports.jsx'), /onClick=\{refreshReport\}>Try Again/)
  assert.match(page('AuditLog.jsx'), /async function refresh\(\)/); assert.match(page('MyReservations.jsx'), /function clearFilters\(\)/)
})
test('search, pagination and print/export controls still present', () => {
  assert.match(page('Equipment.jsx'), /type="search"/); assert.match(page('Reports.jsx'), /Print PDF/); assert.match(page('AuditLog.jsx'), /Save as PDF/) /* CP186 rename */
  assert.match(page('Holidays.jsx'), /Add Holiday/); assert.match(page('RecycleBin.jsx'), /Clear Selection/)
})

test('CP89: Audit Log has exactly one Refresh button, wired to the existing loader and disabled while loading', () => {
  const src = page('AuditLog.jsx'); assert.equal((src.match(/<button[^>]*>\s*Refresh\s*<\/button>/g) || []).length, 1)
  assert.match(src, /<button type="button" onClick=\{loadLogs\} disabled=\{loading\}>Refresh<\/button>/)
})
