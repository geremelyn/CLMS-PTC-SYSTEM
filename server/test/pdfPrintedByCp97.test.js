// CP97: every CLMS PDF shows "Printed by: Surname, First Name, M." for the signed-in user.
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const mod = () => import(pathToFileURL(path.join(__dirname, '../../client/src/utils/pdfHeader.js')).href)

test('format: surname, first name, middle initial', async () => {
  const { formatPrintedByName: f } = await mod()
  assert.equal(f({ surname: 'Dela Cruz', first_name: 'Juan', middle_initial: 'p' }), 'Dela Cruz, Juan, P.')
  assert.equal(f({ surname: 'Santos', first_name: 'Ana Marie', middle_initial: 'B.' }), 'Santos, Ana Marie, B.')
})
test('missing middle initial is left out, not invented', async () => {
  const { formatPrintedByName: f } = await mod()
  assert.equal(f({ surname: 'Reyes', first_name: 'Mark', middle_initial: null }), 'Reyes, Mark')
  assert.equal(f({ surname: 'Reyes', first_name: 'Mark', middle_initial: '  ' }), 'Reyes, Mark')
})
test('legacy account without split name falls back to full_name; nothing -> empty', async () => {
  const { formatPrintedByName: f } = await mod()
  assert.equal(f({ full_name: 'Lab Assistant One' }), 'Lab Assistant One')
  assert.equal(f(null), '')
})
test('document shows the signed-in user (localStorage), keeps header, logos and Letter page', async () => {
  global.localStorage = { getItem: () => JSON.stringify({ surname: 'Cruz', first_name: 'Ana', middle_initial: 'M', role: 'Dean' }) }
  const { buildPdfDocumentHtml } = await mod()
  const html = buildPdfDocumentHtml({ title: 'T', bodyHtml: '<p id="body">BODY</p>', logoBase: '' })
  assert.match(html, /Printed by: Cruz, Ana, M\./)
  assert.match(html, /PATEROS TECHNOLOGICAL COLLEGE/)
  assert.match(html, /clms-logo\.png/); assert.match(html, /icct-logo\.png/)
  assert.match(html, /@page \{ size: 8\.5in 11in/)
  assert.match(html, /<p id="body">BODY<\/p>/)
  delete global.localStorage
})
test('explicit printedBy wins, name is HTML-escaped, no user -> no line', async () => {
  const { buildPdfDocumentHtml } = await mod()
  assert.match(buildPdfDocumentHtml({ printedBy: { surname: 'O<b>', first_name: 'X' } }), /Printed by: O&lt;b&gt;, X/)
  assert.doesNotMatch(buildPdfDocumentHtml({}), /Printed by/)
})
test('all module PDFs go through buildPdfDocumentHtml (no module builds its own document)', () => {
  const fs = require('node:fs')
  for (const f of ['computersPdf', 'usersPdf', 'laboratoriesPdf', 'equipmentPdf', 'myReportsPdf'])
    assert.match(fs.readFileSync(path.join(__dirname, '../../client/src/utils', f + '.js'), 'utf8'), /buildPdfDocumentHtml\(/, f)
})
