// CP187 - typeable pagination (5 rows, Previous / typed page / Next, no Rows dropdown) on every list page. Source-level checks; behaviour is covered by the Chromium run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const src = f => fs.readFileSync(path.join(__dirname, '../../client/src', f), 'utf8')
const SHARED = ['Reservations', 'Laboratories', 'Computers', 'Holidays', 'RecycleBin', 'AuditLog', 'MyReservations']
const OWN_BOX = ['Maintenance', 'Reports', 'TeacherSchedules', 'Equipment']

test('shared PagePager: Previous, typeable digits-only page box clamped on Enter/blur, Next, no select', () => {
  const s = src('components/PagePager.jsx')
  assert.match(s, />Previous</); assert.match(s, />Next</); assert.match(s, /aria-label="Page number"/)
  assert.match(s, /replace\(\/\\D\/g, ''\)/); assert.match(s, /Math\.min\(Math\.max\(1, wanted\), totalPages\)/)
  assert.match(s, /event\.key === 'Enter'/); assert.match(s, /onBlur=/); assert.ok(!/<select/.test(s))
})
for (const page of SHARED) test(`${page}.jsx: uses PagePager, fixed 5 rows, no Rows-per-page dropdown`, () => {
  const s = src(`pages/${page}.jsx`)
  assert.match(s, /import PagePager from '\.\.\/components\/PagePager\.jsx'/); assert.match(s, /<PagePager /)
  assert.match(s, /const pageSize = 5/); assert.ok(!/setPageSize|Rows per page/.test(s))
})
for (const page of OWN_BOX) test(`${page}.jsx: typeable page box + Previous/Next kept, fixed 5 rows, no Rows dropdown`, () => {
  const s = src(`pages/${page}.jsx`)
  assert.match(s, /aria-label="Page number"/); assert.match(s, />Previous</); assert.match(s, />Next</)
  assert.ok(!/setPageSize|Rows per page|Rows <select/.test(s)); assert.match(s, /pageSize = 5|PAGE_SIZE = 5/)
})
test('Users.jsx keeps its 5-row pager', () => { const s = src('pages/Users.jsx'); assert.match(s, /const pageSize = 5/); assert.match(s, /aria-label="Page number"/) })
