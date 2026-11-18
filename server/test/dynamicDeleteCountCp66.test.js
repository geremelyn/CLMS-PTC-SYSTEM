'use strict'
// CP66: static source checks only (no browser). Confirms the selected-delete label carries the live count and handlers are unchanged.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const page = name => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', name), 'utf8')
test('Laboratories: label shows Delete (N) from selectedLabIds; Delete All fallback and handler unchanged', () => {
  const s = page('Laboratories.jsx')
  assert.match(s, /onClick=\{handleDeleteAllLabs\} disabled=\{!visibleLaboratories\.length && !selectedLabIds\.length\}>\{selectedLabIds\.length \? `Delete \(\$\{selectedLabIds\.length\}\)` : 'Delete All'\}/)
  assert.match(s, /function handleSelectAllLabs\(\) \{ setSelectedLabIds\(visibleLaboratories/); assert.match(s, /function handleClearSelection\(\) \{ setSelectedLabIds\(\[\]\)/)
  assert.match(s, /api\.post\('\/laboratories\/bulk-delete', \{ ids \}\)/)
})
test('Equipment: label shows Delete Selected (N) (CP164 matched Reservations; CP170 updated this stale assertion); stays disabled with no selection; permission gate kept', () => {
  const s = page('Equipment.jsx')
  assert.match(s, /\{canManageEquipment && <button[^>]*onClick=\{deleteAllEquipment\} disabled=\{!selectedEquipmentIds\.length\}>\{selectedEquipmentIds\.length \? `Delete Selected \(\$\{selectedEquipmentIds\.length\}\)` : 'Delete All'\}/)
  assert.match(s, /function selectAllEquipment\(\) \{ setSelectedEquipmentIds\(visible\.map/); assert.match(s, /function clearEquipmentSelection\(\) \{ setSelectedEquipmentIds\(\[\]\)/)
})
test('Holidays: label shows Delete (N); Deleting… state and disabled rule kept', () => {
  const s = page('Holidays.jsx')
  assert.match(s, /disabled=\{!selectedIds\.length \|\| deleting\}>\{deleting \? 'Deleting…' : selectedIds\.length \? `Delete \(\$\{selectedIds\.length\}\)` : 'Delete All'\}/)
})
test('pages that already show a live count are untouched', () => {
  assert.match(page('Computers.jsx'), /Delete selected \(\{selectedComputerIds\.length\}\)/)
  assert.match(page('Users.jsx'), /Delete selected \(\{selectedUserIds\.length\}\)/)
  assert.match(page('Maintenance.jsx'), /Delete \(\{selectedInView\.length\}\)/)
  assert.match(page('Reservations.jsx'), /Delete Selected \(\$\{selectedIds\.length\}\)/)
  assert.match(page('RecycleBin.jsx'), /Permanent Delete \(\{selected\.length\}\)/)
})
