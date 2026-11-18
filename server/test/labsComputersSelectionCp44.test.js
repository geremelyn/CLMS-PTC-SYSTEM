// CP44 STATIC regression test (reads the page source; it does NOT render the pages and uses no database).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const page = name => fs.readFileSync(path.resolve(__dirname, '../../client/src/pages', name), 'utf8')

test('Laboratories: changing the search clears the selection so hidden rows can never be deleted', () => {
  const src = page('Laboratories.jsx')
  assert.match(src, /id="labs-search"[\s\S]{0,60}onChange=\{event => \{ setSearchTerm\(event\.target\.value\); setCurrentPage\(1\); setSelectedLabIds\(\[\]\) \}\}/)
})
test('Computers: single Select All / Clear Selection toggle (CP189), Select All selects the whole searched list', () => {
  const src = page('Computers.jsx')
  assert.match(src, /function toggleSelectAllComputers\(\) \{[^}]*setSelectedComputerIds\(visibleComputers\.map/s)
  assert.doesNotMatch(src, /ids\.every\(id => current\.includes\(id\)\) \? \[\] : ids/)
  assert.match(src, /onClick=\{allVisibleComputersSelected \? handleClearComputerSelection : toggleSelectAllComputers\} disabled=\{!visibleComputers\.length\}>\{allVisibleComputersSelected \? "Clear Selection" : "Select All"\}<\/button>/)
  assert.doesNotMatch(src, /Search all computer fields/)
})
test('Computers: search change still clears selection; role gating of import/export/PDF unchanged', () => {
  const src = page('Computers.jsx')
  assert.match(src, /id="computers-search"[\s\S]{0,320}setSelectedComputerIds\(\[\]\)/)
  // CP84: the separate Import/Export/PDF buttons were folded into the File Actions menu (CP62); role gating now lives there (pdf flag + role).
  assert.match(src, /<FileActionsMenu module="computers" role=\{user\?\.role\} pdf=\{isMIS \|\| isInventory\} importProps=\{\{ endpoint: "\/computers"/)
  assert.match(src, /onExport=\{exportComputers\} onPdf=\{saveComputersPdf\}/)
})
