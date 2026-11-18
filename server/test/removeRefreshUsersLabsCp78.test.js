'use strict'
// CP78: static source checks only (no browser, no DB). Manual Refresh removed from Users and Laboratories;
// automatic loading, post-action reloads, search, pagination and Try Again remain.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const page = name => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', name), 'utf8')
const users = page('Users.jsx'), labs = page('Laboratories.jsx')

test('no manual Refresh button remains on Users or Laboratories', () => {
  for (const [n, src] of [['Users', users], ['Laboratories', labs]]) {
    assert.doesNotMatch(src, /<button[^>]*>[^<]*Refresh[^<]*<\/button>/, n)
    assert.doesNotMatch(src, /Refreshing…/, n)
  }
})
test('Users: automatic load, post-action reloads and Try Again error recovery intact', () => {
  assert.match(users, /async function getUsers\(\)/)
  assert.match(users, /useEffect\([\s\S]{0,200}getUsers\(\)/)
  assert.ok((users.match(/await getUsers\(\)/g) || []).length >= 5, 'reload after create/update/delete/restore/import')
  assert.match(users, /onImported: getUsers/)
  assert.match(users, /onClick=\{getUsers\}>Try Again<\/button>/)
  assert.match(users, /Loading user accounts…/)
  assert.match(users, /Select All/); assert.match(users, /Add User/)
})
test('Laboratories: automatic load, search/pagination and bulk controls intact', () => {
  assert.match(labs, /await api\.get\('\/laboratories'\)/)
  assert.match(labs, /useEffect\(/)
  assert.match(labs, /id="labs-search" type="search"/)
  assert.match(labs, /setCurrentPage\(1\)/)
  assert.match(labs, /className="labs-toolbar"/) // CP119: the search now lives in the single labs toolbar row (was .labs-search-row)
})
