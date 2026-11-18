const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// CP119 source-contract checks. Real behaviour (Sundays/holidays unselectable, one-row toolbar, mobile) is covered by the browser run.
const client = file => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', file), 'utf8')
const labs = client('pages/Laboratories.jsx')
const css = client('pages/Laboratories.css')

test('Laboratory Add/Edit date fields use the shared reservation calendar rules (Sundays + holidays blocked, no holiday list)', () => {
  const pickers = labs.match(/<DatePicker [^>]*>/g) || []
  assert.equal(pickers.length, 6)
  for (const picker of pickers) {
    assert.doesNotMatch(picker, /restrictDays=\{false\}/, 'every lab date picker keeps Sunday/holiday restrictions')
    assert.match(picker, /showHolidayList=\{false\}/, 'same as the Teacher reservation calendar')
  }
})

test('Total Laboratories context box sits above the toolbar; search and action buttons share one toolbar', () => {
  assert.match(labs, /className="labs-toolbar"/)
  assert.match(labs, /className="labs-context-box[^"]*"[\s\S]{0,120}Total Laboratories[\s\S]{0,80}laboratories\.length/)
  assert.ok(labs.indexOf('labs-context-box') < labs.indexOf('className="labs-toolbar"'), 'context box precedes toolbar')
  const toolbar = labs.slice(labs.indexOf('className="labs-toolbar"'), labs.indexOf('{/* Table */}'))
  for (const needle of ['labs-search', '+ Add Laboratory', 'FileActionsMenu', 'Select All', 'Clear Selection', 'Delete']) assert.ok(toolbar.includes(needle), needle)
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*labs-toolbar-actions/, 'mobile layout rule present')
})
