// CP107: User Accounts are listed A-Z by the displayed name (Surname, First, M.I.). Pure sorter (no DOM, no database, no HTTP)
// plus static wiring checks against Users.jsx.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/userSort.js')).href)
const names = (list) => list.map(u => `${u.surname ?? ''}|${u.first_name ?? ''}`)
const U = (id, surname, first_name, extra = {}) => ({ id, surname, first_name, middle_initial: '', full_name: `${first_name} ${surname}`, username: `u${id}`, role: 'Teacher', ...extra })

test('sorts A-Z by displayed surname then first name, ignoring capitalization', async () => {
  const { sortUsersByName } = await load()
  const out = sortUsersByName([U(1, 'santos', 'maria'), U(2, 'Reyes', 'Ana'), U(3, 'REYES', 'ben'), U(4, 'Cruz', 'Liza'), U(5, 'cruz', 'Aaron')])
  assert.deepEqual(names(out), ['cruz|Aaron', 'Cruz|Liza', 'Reyes|Ana', 'REYES|ben', 'santos|maria'])
})
test('first name breaks surname ties, then middle initial, then username/id (fully deterministic)', async () => {
  const { sortUsersByName } = await load()
  const a = U(10, 'Lee', 'Sam', { middle_initial: 'B', username: 'x2' }), b = U(11, 'Lee', 'Sam', { middle_initial: 'A', username: 'x9' }), c = U(12, 'Lee', 'Sam', { middle_initial: 'A', username: 'x1' })
  assert.deepEqual(sortUsersByName([a, b, c]).map(u => u.id), [12, 11, 10])
  assert.deepEqual(sortUsersByName([c, a, b]).map(u => u.id), [12, 11, 10])
})
test('accents and numbers are handled; MIS shows as "Super Admin" like the table', async () => {
  const { sortUsersByName } = await load()
  const out = sortUsersByName([U(1, 'Zamora', 'Z'), U(2, 'Álvarez', 'Ana'), U(3, 'Alvaro', 'Bo'), U(4, 'Student 10', 'X'), U(5, 'Student 2', 'X'), { id: 6, role: 'MIS', full_name: 'Zed Head', surname: 'Head', first_name: 'Zed', username: 'admin' }])
  assert.deepEqual(out.map(u => u.id), [2, 3, 5, 4, 6, 1], 'Álvarez, Alvaro, Student 2, Student 10, Super Admin, Zamora (accent ignored; 2 before 10)')
})
test('missing names: falls back to full_name like the table; accounts with no usable name go last', async () => {
  const { sortUsersByName } = await load()
  const out = sortUsersByName([
    { id: 1, full_name: '', username: 'blank1', role: 'Teacher' },
    { id: 2, full_name: 'Juan P. Zulueta', username: 'legacy', role: 'Dean' },          // legacy row: no surname/first columns
    { id: 3, full_name: null, username: 'blank2', role: 'Others' },
    U(4, 'Bautista', 'Eli'),
    { id: 5, surname: 'Adams', first_name: '', full_name: 'Adams', username: 'only-surname', role: 'Teacher' },
  ])
  assert.deepEqual(out.map(u => u.id), [5, 4, 2, 1, 3], 'Adams, Bautista, Zulueta (legacy), then the two blank-name accounts by username')
})
test('does not mutate its input, is idempotent, and tolerates non-arrays', async () => {
  const { sortUsersByName } = await load()
  const input = [U(1, 'b', 'x'), U(2, 'a', 'x')]; const copy = JSON.stringify(input)
  const once = sortUsersByName(input)
  assert.equal(JSON.stringify(input), copy); assert.deepEqual(sortUsersByName(once).map(u => u.id), once.map(u => u.id))
  assert.deepEqual(sortUsersByName(null), []); assert.deepEqual(sortUsersByName(undefined), [])
})
test('a search-filtered or paged slice of the sorted list stays in A-Z order (filter/slice never reorder)', async () => {
  const { sortUsersByName } = await load()
  const all = sortUsersByName(Array.from({ length: 25 }, (_, i) => U(i + 1, String.fromCharCode(90 - i) + 'x', 'f')))
  const filtered = all.filter(u => /[a-m]/i.test(u.surname[0]))
  assert.deepEqual(filtered.map(u => u.surname), [...filtered.map(u => u.surname)].sort((p, q) => p.localeCompare(q)))
  const page2 = all.slice(10, 20); assert.equal(page2[0].surname > all[9].surname, true)
})
test('Users.jsx wiring: the sorted list feeds search, pagination, export and PDF; no other sorting; server query untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/Users.jsx'), 'utf8')
  assert.match(src, /import \{ sortUsersByName \} from '\.\.\/utils\/userSort\.js'/)
  assert.match(src, /const sortedUsers = sortUsersByName\(users\)/)
  assert.match(src, /const visibleUsers = sortedUsers\.filter\(/)
  assert.match(src, /const pageUsers = visibleUsers\.slice\(/)
  const ctrl = fs.readFileSync(path.join(__dirname, '../controllers/userController.js'), 'utf8')
  assert.match(ctrl, /FROM users ORDER BY full_name ASC/)
})
