// CP144 - Audit Log Event Type dropdown. UNIT: the real filter helpers run on fixture records (MOCKED data, no HTTP, no database).
// SOURCE-LEVEL: page/CSS wiring and a check that every always-offered event name really exists in the server source (nothing invented).
// Real-browser behaviour: tools/browser-tests/group3/t37_cp144_audit_event_type_filter.js (real Chromium; API MOCKED, no real MySQL).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url')
const ROOT = path.join(__dirname, '../..'), U = f => import(pathToFileURL(path.join(ROOT, 'client/src/utils', f)).href)
const page = fs.readFileSync(path.join(ROOT, 'client/src/pages/AuditLog.jsx'), 'utf8'), css = fs.readFileSync(path.join(ROOT, 'client/src/pages/AuditLog.css'), 'utf8')
const roleLabel = l => l.role || '—'
const mk = n => Array.from({ length: n }, (_, i) => ({ id: n - i, action: i % 3 === 0 ? 'USER LOGIN' : i % 3 === 1 ? 'USER LOGOUT' : 'RESERVATION APPROVED', description: `d${n - i}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, 0) - i * 60000).toISOString(), full_name: i % 2 ? 'Ana Cruz' : 'Ben Reyes', username: 'u' + i, role: 'Teacher' })) // newest first, like the API

function serverSource() { const out = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === 'node_modules' || f.name === 'test') continue; const p = path.join(d, f.name); f.isDirectory() ? walk(p) : p.endsWith('.js') && out.push(fs.readFileSync(p, 'utf8')) } }; walk(path.join(ROOT, 'server')); return out.join('\n') }
test('every always-offered event type exists in the server source (no invented types)', async () => {
  const { KNOWN_AUDIT_EVENTS } = await U('auditEventFilter.mjs'), src = serverSource()
  const missing = KNOWN_AUDIT_EVENTS.filter(name => {
    if (src.includes(`'${name}'`) || src.includes(`"${name}"`)) return false
    const m = name.match(/^([A-Z ]+) DELETE$/) // recycle bin writes `${type.toUpperCase()} DELETE`
    return !(m && src.includes('${type.toUpperCase()} DELETE') && /maintenance/.test(src))
  })
  assert.deepEqual(missing, [])
  for (const t of ['USER LOGIN', 'USER LOGOUT', 'MAINTENANCE DELETE']) assert.ok(KNOWN_AUDIT_EVENTS.includes(t), t)
  assert.equal(new Set(KNOWN_AUDIT_EVENTS).size, KNOWN_AUDIT_EVENTS.length)
})
test('dropdown = fixed server events + every distinct action found in the data (dynamic ones included), sorted, no blanks', async () => {
  const { auditEventTypes, KNOWN_AUDIT_EVENTS } = await U('auditEventFilter.mjs')
  const t = auditEventTypes([{ action: 'COMPUTERS IMPORT' }, { action: ' RESERVATION REJECTED ' }, { action: '' }, { action: null }, { action: 'USER LOGIN' }], KNOWN_AUDIT_EVENTS)
  assert.ok(t.includes('COMPUTERS IMPORT') && t.includes('RESERVATION REJECTED') && t.includes('USER LOGIN') && !t.includes('')); assert.equal(new Set(t).size, t.length)
  assert.deepEqual(t, [...t].sort((a, b) => a.localeCompare(b)))
})
test('selecting an event type filters exactly; All Event Types (empty value) clears it', async () => {
  const { filterAuditLogs, ALL_EVENTS } = await U('auditEventFilter.mjs'), logs = mk(30)
  const login = filterAuditLogs(logs, { eventType: 'USER LOGIN', roleLabel }); assert.equal(login.length, 10); assert.ok(login.every(l => l.action === 'USER LOGIN'))
  assert.equal(filterAuditLogs(logs, { eventType: ALL_EVENTS, roleLabel }).length, 30); assert.equal(ALL_EVENTS, '')
  assert.equal(filterAuditLogs(logs, { eventType: 'USER LOGIN', roleLabel }).length, 10, 'source not mutated')
  assert.equal(filterAuditLogs(logs, { eventType: 'HOLIDAY ADDED', roleLabel }).length, 0)
  assert.equal(filterAuditLogs(logs, { eventType: 'USER', roleLabel }).length, 0, 'exact match, not substring')
})
test('search + event type work together (AND) in both directions and clearing either keeps the other', async () => {
  const { filterAuditLogs, ALL_EVENTS } = await U('auditEventFilter.mjs'), logs = mk(30)
  const both = filterAuditLogs(logs, { eventType: 'USER LOGIN', search: 'ana', roleLabel }); assert.ok(both.length > 0 && both.every(l => l.action === 'USER LOGIN' && l.full_name === 'Ana Cruz'))
  const onlySearch = filterAuditLogs(logs, { eventType: ALL_EVENTS, search: 'ana', roleLabel }), onlyType = filterAuditLogs(logs, { eventType: 'USER LOGIN', roleLabel })
  assert.ok(both.length < onlySearch.length && both.length < onlyType.length)
  assert.deepEqual(both.map(l => l.id), onlySearch.filter(l => l.action === 'USER LOGIN').map(l => l.id))
  assert.equal(filterAuditLogs(logs, { eventType: 'USER LOGIN', search: 'zzz-none', roleLabel }).length, 0)
  assert.equal(filterAuditLogs(logs, { eventType: 'USER LOGIN', search: '  ANA ', roleLabel }).length, both.length, 'search is trimmed/case-insensitive as before')
})
test('sorting is preserved (API order, newest first) and pagination math works on the FILTERED list', async () => {
  const { filterAuditLogs } = await U('auditEventFilter.mjs'), logs = mk(90), f = filterAuditLogs(logs, { eventType: 'USER LOGIN', roleLabel }) // 30 records
  assert.deepEqual(f.map(l => l.id), [...f.map(l => l.id)].sort((a, b) => b - a), 'filtered order = API order')
  const size = 10, pages = Math.max(1, Math.ceil(f.length / size)); assert.equal(pages, 3)
  const seen = []; for (let p = 1; p <= pages; p++) seen.push(...f.slice((p - 1) * size, p * size)); assert.deepEqual(seen.map(l => l.id), f.map(l => l.id))
  assert.ok(seen.every(l => l.action === 'USER LOGIN'))
})
test('page wiring: option label is "All Event Types", page resets to 1 on filter/search change, page uses the filtered list, search field and dropdown share one row', () => {
  assert.match(page, /<option value=\{ALL_EVENTS\}>All Event Types<\/option>/); assert.doesNotMatch(page, />All Events</)
  assert.match(page, /onChange=\{event => \{ setEventType\(event\.target\.value\); setCurrentPage\(1\) \}\}/)
  assert.match(page, /onChange=\{event => \{ setSearchTerm\(event\.target\.value\); setCurrentPage\(1\) \}\}/)
  assert.match(page, /filterAuditLogs\(logs, \{ eventType: activeEventType, search, roleLabel \}\)/); assert.match(page, /filteredLogs\.slice\(\(safePage - 1\) \* pageSize/)
  assert.match(page, /className="audit-search-row no-print">[\s\S]*?id="audit-search"[\s\S]*?id="audit-event-type"/)
})
test('dropdown text is white on the dark-green theme (closed control and opened options)', () => {
  assert.match(css, /\.audit-search-row \.audit-event-select\{[^}]*background:var\(--clms-input-bg,#064b36\);color:#fff/)
  assert.match(css, /\.audit-event-select option\{background:var\(--clms-input-bg,#064b36\);color:#fff\}/); assert.doesNotMatch(css, /audit-event-select option\{color:#111\}/)
})
test('permissions and backend unchanged: MIS-only page, API route MIS-only, controller still takes no event filter, PDF builder untouched', () => {
  assert.match(page, /user\?\.role !== 'MIS'\) return <div className="audit-denied">/)
  const ctl = fs.readFileSync(path.join(ROOT, 'server/controllers/auditLogController.js'), 'utf8'); assert.doesNotMatch(ctl, /event/i)
  assert.match(fs.readFileSync(path.join(ROOT, 'server/routes/auditLogRoutes.js'), 'utf8'), /requireRole\('MIS'\)/)
})
