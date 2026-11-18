// CP108 - Audit Log Event Type filter.
// UNIT: pure helpers (client/src/utils/auditEventFilter.mjs) are executed for real.
// SOURCE-LEVEL: page wiring, route permission and PDF wiring are checked by reading files.
// NOT covered: real browser rendering, real MySQL, live HTTP.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const read = rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const H = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/auditEventFilter.mjs')).href)
const roleLabel = l => (l.role === 'Inventory Staff' ? 'MIS Staff' : l.role || '—')
const LOGS = [
  { id: 1, action: 'USER LOGIN', description: 'Ana Reyes logged in.', created_at: '2026-11-01T08:00:00Z', full_name: 'Ana Reyes', username: '2024-0001', role: 'Teacher' },
  { id: 2, action: 'RESERVATION APPROVED', description: 'Approved Lab 1 for Ana Reyes', created_at: '2026-11-02T08:00:00Z', full_name: 'Super Admin', username: 'admin', role: 'MIS' },
  { id: 3, action: 'COMPUTERS IMPORT', description: 'Imported 5 computers', created_at: '2026-11-03T08:00:00Z', full_name: 'Ben Cruz', username: '2024-0002', role: 'Inventory Staff' },
  { id: 4, action: 'USER LOGIN', description: 'Ben Cruz logged in.', created_at: '2026-11-04T08:00:00Z', full_name: 'Ben Cruz', username: '2024-0002', role: 'Inventory Staff' },
  { id: 5, action: null, description: 'No action recorded', created_at: null, full_name: '', username: '', role: null },
]
const ids = r => r.map(l => l.id)

test('event types are the distinct actual actions in the data (no invented types), sorted, blanks ignored', async () => {
  const { auditEventTypes } = await H()
  assert.deepEqual(auditEventTypes(LOGS), ['COMPUTERS IMPORT', 'RESERVATION APPROVED', 'USER LOGIN'])
  assert.deepEqual(auditEventTypes([]), [])
  assert.deepEqual(auditEventTypes(undefined), [])
})

test('All Events returns every record; a specific event type returns only exact matches', async () => {
  const { filterAuditLogs, ALL_EVENTS } = await H()
  assert.equal(ALL_EVENTS, '')
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: ALL_EVENTS, roleLabel })), [1, 2, 3, 4, 5])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'USER LOGIN', roleLabel })), [1, 4])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'COMPUTERS IMPORT', roleLabel })), [3])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'LOGIN', roleLabel })), [], 'exact match, not substring')
})

test('Event Type works together with the existing search (AND)', async () => {
  const { filterAuditLogs } = await H()
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'USER LOGIN', search: 'ben', roleLabel })), [4])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'USER LOGIN', search: '  ANA ', roleLabel })), [1])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'RESERVATION APPROVED', search: 'ben', roleLabel })), [])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { search: 'mis staff', roleLabel })), [3, 4], 'search alone unchanged (role label searchable)')
  assert.deepEqual(ids(filterAuditLogs(LOGS, { search: 'system', roleLabel })), [5], 'blank name still searchable as System')
})

test('clearing the filter (back to All Events) restores results; source data is not mutated', async () => {
  const { filterAuditLogs, ALL_EVENTS } = await H()
  const snapshot = JSON.stringify(LOGS)
  const narrowed = filterAuditLogs(LOGS, { eventType: 'USER LOGIN', search: 'ben', roleLabel })
  assert.deepEqual(ids(narrowed), [4])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: ALL_EVENTS, search: 'ben', roleLabel })), [3, 4], 'filter cleared, search kept')
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: ALL_EVENTS, search: '', roleLabel })), [1, 2, 3, 4, 5], 'both cleared')
  assert.equal(JSON.stringify(LOGS), snapshot)
})

test('page wiring: All Event Types option, dropdown from loaded events, resets page, stale selection falls back, PDF/table/search kept', () => {
  const src = read('../../client/src/pages/AuditLog.jsx')
  assert.match(src, /id="audit-event-type"/); assert.match(src, /htmlFor="audit-event-type"/)
  assert.match(src, /<option value=\{ALL_EVENTS\}>All Event Types<\/option>/)
  assert.match(src, /eventTypes\.map\(type => <option key=\{type\} value=\{type\}>\{type\}<\/option>\)/)
  assert.match(src, /auditEventTypes\(logs(, KNOWN_AUDIT_EVENTS)?\)/) /* CP120: known types merged in */; assert.match(src, /eventTypes\.includes\(eventType\) \? eventType : ALL_EVENTS/)
  assert.match(src, /setEventType\(event\.target\.value\); setCurrentPage\(1\)/)
  assert.match(src, /filterAuditLogs\(logs, \{ eventType: activeEventType, search, roleLabel \}\)/)
  assert.match(src, /id="audit-search" type="search"/)
  assert.match(src, /buildAuditLogPdfHtml\(filteredLogs, \{ roleLabel, search: searchTerm\.trim\(\)/)
  assert.match(src, /<th>Action<\/th><th>Description<\/th><th>Date &amp; Time<\/th><th>Recorded By<\/th><th>ID Number<\/th><th>Role<\/th>/)
  assert.match(src, /No audit activities match your search\./)
})

test('permissions unchanged: page denies non-MIS, only MIS may load logs, API route is MIS only, controller takes no new filter', () => {
  const src = read('../../client/src/pages/AuditLog.jsx')
  assert.match(src, /if \(user\?\.role === 'MIS'\)/)
  assert.match(src, /if \(user\?\.role !== 'MIS'\) return <div className="audit-denied">/)
  assert.match(read('../routes/auditLogRoutes.js'), /router\.get\('\/', requireRole\('MIS'\), getAuditLogs\)/)
  assert.doesNotMatch(read('../controllers/auditLogController.js'), /request\.query\?\.(action|event)/)
  assert.doesNotMatch(read('../../client/src/utils/auditEventFilter.mjs'), /api\.|fetch\(/)
})
