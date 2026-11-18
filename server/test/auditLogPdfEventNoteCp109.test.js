// CP109 - Audit Log PDF filter note shows the selected Event Type only when one is selected.
// UNIT: the real PDF HTML builder runs. SOURCE-LEVEL: page passes the active event type. No browser/DB here (see tools/browser-tests/group3/t29).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const U = f => import(pathToFileURL(path.join(__dirname, '../../client/src/utils', f)).href)
const roleLabel = l => l.role || '—'
const LOGS = [{ id: 1, action: 'USER LOGIN', description: 'x', created_at: '2026-11-01T08:00:00Z', full_name: 'Ana', username: '1', role: 'Teacher' }]
const NOW = new Date('2026-11-12T05:00:00Z')
const meta = async opts => { const { buildAuditLogPdfHtml } = await U('auditLogPdf.js'); const h = buildAuditLogPdfHtml(LOGS, { roleLabel, now: NOW, ...opts }); return { html: h, meta: (h.match(/<p class="pdf-meta">([\s\S]*?)<\/p>/) || [])[1] } }

test('All Events (no/empty event type): meta line is exactly the pre-CP109 text', async () => {
  const a = await meta({}), b = await meta({ eventType: '' })
  assert.doesNotMatch(a.meta, /Event type/); assert.equal(a.html, b.html)
  assert.match(a.meta, /^Total records: 1 &nbsp;\|&nbsp; Generated: /)
  assert.match((await meta({ search: 'ana' })).meta, /^Total records: 1 &nbsp;\|&nbsp; Search filter: “ana” &nbsp;\|&nbsp; Generated: /)
})
test('a specific event type is added to the filter note; combined with search both appear', async () => {
  assert.match((await meta({ eventType: 'USER LOGIN' })).meta, /^Total records: 1 &nbsp;\|&nbsp; Event type: “USER LOGIN” &nbsp;\|&nbsp; Generated: /)
  assert.match((await meta({ eventType: 'USER LOGIN', search: 'ana' })).meta, /^Total records: 1 &nbsp;\|&nbsp; Event type: “USER LOGIN” &nbsp;\|&nbsp; Search filter: “ana” &nbsp;\|&nbsp; Generated: /)
})
test('event type is HTML-escaped; layout/branding markup unchanged apart from the note', async () => {
  assert.match((await meta({ eventType: '<b>&"' })).meta, /Event type: “&lt;b&gt;&amp;(&quot;|")”/)
  const strip = h => h.replace(/ &nbsp;\|&nbsp; Event type: “[^”]*”/, '')
  assert.equal(strip((await meta({ eventType: 'USER LOGIN' })).html), (await meta({})).html)
})
test('page passes the ACTIVE event type to the PDF builder', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/AuditLog.jsx'), 'utf8')
  assert.match(src, /buildAuditLogPdfHtml\(filteredLogs, \{ roleLabel, search: searchTerm\.trim\(\), eventType: activeEventType, logoBase: window\.location\.origin \}\)/)
})
