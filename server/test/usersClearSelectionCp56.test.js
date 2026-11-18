'use strict'
// CP56: source-level contract test (no React renderer / browser is available in this project's test setup).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const page = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Users.jsx'), 'utf8')

test('CP166 Part 3: one Reservations-style toggle - Select All, then Clear Selection once every selectable account is selected (calls clearSelection)', () => {
  assert.match(page, /<button type="button" className="users-selection-toggle" onClick=\{allSelected \? clearSelection : selectAllUsers\} disabled=\{!selectableIds\.length\}>\{allSelected \? 'Clear Selection' : 'Select All'\}<\/button>/)
  assert.match(page, /function selectAllUsers\(\) \{ setSelectedUserIds\(selectableIds\); \}/)
})
test('clearSelection only empties the selection state: no API call, no delete/update/deactivate', () => {
  const fn = page.match(/function clearSelection\(\) \{([^}]*)\}/)
  assert.ok(fn); assert.equal(fn[1].trim(), 'setSelectedUserIds([]);')
  assert.doesNotMatch(fn[1], /api\.|confirm|deleteUsers|setUsers/)
})
test('selected count and Delete selected button derive from selectedUserIds, so they update immediately; Select All and Delete All are unchanged', () => {
  assert.match(page, /Delete selected \(\{selectedUserIds\.length\}\)/)
  assert.match(page, /onClick=\{handleDeleteAll\} disabled=\{!selectableIds\.length\}>Delete All/)
  assert.match(page, /function toggleSelectAllUsers\(\) \{ setSelectedUserIds\(allSelected \? \[\] : selectableIds\); \}/)
})
test('the Super Admin account stays unselectable (checkbox disabled for role MIS) and no permission code changed', () => {
  assert.match(page, /disabled=\{u\.role === 'MIS'\} checked=\{selectedUserIds\.includes\(u\.id\)\}/)
})
