// CP120 - Audit Log Event Type filter completion.
// UNIT: real filter helpers and the real PDF HTML builder run. SOURCE-LEVEL: page wiring. Real-browser filtering/Refresh/PDF-note run was done separately (see CHANGELOG).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const U = f => import(pathToFileURL(path.join(__dirname, '../../client/src/utils', f)).href)
const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/AuditLog.jsx'), 'utf8')
const roleLabel = l => l.role || '—'
const NOW = new Date('2026-11-12T05:00:00Z')
const LOGS = [
  { id: 1, action: 'USER LOGIN', description: 'a', created_at: '2026-11-01T08:00:00Z', full_name: 'Ana', username: '1', role: 'Teacher' },
  { id: 2, action: 'USER LOGOUT', description: 'b', created_at: '2026-11-01T09:00:00Z', full_name: 'Ana', username: '1', role: 'Teacher' },
  { id: 3, action: 'MAINTENANCE DELETE', description: 'c', created_at: '2026-11-02T09:00:00Z', full_name: 'Admin', username: 'admin', role: 'MIS' },
  { id: 4, action: 'RESERVATION APPROVED', description: 'd', created_at: '2026-11-03T09:00:00Z', full_name: 'Admin', username: 'admin', role: 'MIS' },
]
const ids = r => r.map(l => l.id)

test('dropdown always offers Login, Logout and Maintenance Delete (and the other fixed server events), plus every other type found in the data (no duplicates, sorted)', async () => {
  const { auditEventTypes, KNOWN_AUDIT_EVENTS } = await U('auditEventFilter.mjs')
  const base = auditEventTypes([], KNOWN_AUDIT_EVENTS)   // CP144: the fixed server events (see auditLogEventFilterCp144.test.js for the source check)
  for (const t of ['USER LOGIN', 'USER LOGOUT', 'MAINTENANCE DELETE']) assert.ok(base.includes(t), t)
  assert.deepEqual(base, [...base].sort((a, b) => a.localeCompare(b)))
  const withData = auditEventTypes(LOGS, KNOWN_AUDIT_EVENTS)
  assert.deepEqual(withData, [...new Set([...base, 'RESERVATION APPROVED'])].sort((a, b) => a.localeCompare(b)))
  assert.equal(new Set(withData).size, withData.length)
  assert.deepEqual(auditEventTypes(LOGS), ['MAINTENANCE DELETE', 'RESERVATION APPROVED', 'USER LOGIN', 'USER LOGOUT'], 'CP108 behaviour without known types is unchanged')
})

test('selecting a type filters correctly; a known type with no records gives an empty list; All Events restores everything', async () => {
  const { filterAuditLogs, ALL_EVENTS } = await U('auditEventFilter.mjs')
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'USER LOGIN', roleLabel })), [1])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'USER LOGOUT', roleLabel })), [2])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: 'MAINTENANCE DELETE', roleLabel })), [3])
  assert.deepEqual(ids(filterAuditLogs(LOGS.filter(l => l.id !== 3), { eventType: 'MAINTENANCE DELETE', roleLabel })), [])
  assert.deepEqual(ids(filterAuditLogs(LOGS, { eventType: ALL_EVENTS, roleLabel })), [1, 2, 3, 4])
})

test('Refresh restores the default filter: loadLogs (the Refresh handler) clears search, resets Event Type to All Events and page 1, then reloads', () => {
  const body = page.slice(page.indexOf('async function loadLogs()'), page.indexOf('useEffect('))
  assert.match(body, /setSearchTerm\(''\)/)
  assert.match(body, /setEventType\(ALL_EVENTS\)/)
  assert.match(body, /setCurrentPage\(1\)/)
  assert.match(body, /api\.get\('\/audit-logs'\)/)
  assert.match(page, /<button type="button" onClick=\{loadLogs\} disabled=\{loading\}>Refresh<\/button>/)
  assert.match(page, /auditEventTypes\(logs, KNOWN_AUDIT_EVENTS\)/)
})

test('PDF filter note: All Events keeps the normal note; a selected type is added; type + search both appear', async () => {
  const { buildAuditLogPdfHtml } = await U('auditLogPdf.js')
  const meta = opts => (buildAuditLogPdfHtml(LOGS, { roleLabel, now: NOW, ...opts }).match(/<p class="pdf-meta">([\s\S]*?)<\/p>/) || [])[1]
  const normal = meta({ eventType: '' })
  assert.ok(!/Event type/.test(normal) && /Total records: 4/.test(normal))
  assert.equal(meta({}), normal)
  assert.match(meta({ eventType: 'USER LOGOUT' }), /Event type: “USER LOGOUT”/)
  assert.match(meta({ eventType: 'MAINTENANCE DELETE' }), /Event type: “MAINTENANCE DELETE”/)
  const both = meta({ eventType: 'USER LOGIN', search: 'ana' })
  assert.match(both, /Event type: “USER LOGIN”/); assert.match(both, /Search filter: “ana”/)
  assert.match(page, /eventType: activeEventType/)
})
