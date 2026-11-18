const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const zlib = require('node:zlib')
function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function load(rows) {
  const queries = []
  stub('../database/db.js', { query: (sql, values, cb) => { queries.push({ sql: sql.replace(/\s+/g, ' '), values }); cb(null, rows) } })
  delete require.cache[path.resolve(__dirname, '../controllers/dataExportController.js')]
  return { mod: require('../controllers/dataExportController.js'), queries }
}
const res = () => ({ code: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v }, status(c) { this.code = c; return this }, json(b) { this.body = b; return this }, send(b) { this.body = b; return this } })
const text = buffer => buffer.toString('latin1') // xlsx writer output is a zip; stored/deflated entries are searched below
function sheetXml(buffer) { // find any readable xml text inside the (possibly stored) zip
  const raw = buffer.toString('utf8'); if (raw.includes('<row')) return raw
  let out = ''; let i = 0
  while ((i = buffer.indexOf(Buffer.from('PK\x03\x04'), i)) >= 0) {
    const method = buffer.readUInt16LE(i + 8), csize = buffer.readUInt32LE(i + 18), nlen = buffer.readUInt16LE(i + 26), xlen = buffer.readUInt16LE(i + 28)
    const start = i + 30 + nlen + xlen, data = buffer.subarray(start, start + csize)
    try { out += (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8') } catch { /* skip */ }
    i = start + csize
  }
  return out
}
test('users export is built from database rows, includes the requested columns and NEVER a password', () => {
  const rows = [{ id: 5, username: '2026001', full_name: 'Ana B. Cruz', surname: 'Cruz', first_name: 'Ana', middle_initial: 'B', program: 'BSIT', role: 'Teacher', role_other: null, status: 'ACTIVE', password: 'SECRETHASH' }]
  const { mod, queries } = load(rows), r = res()
  mod.createDataExportController('users')({ body: { ids: [5] } }, r)
  assert.equal(r.code, 200); assert.match(r.headers['Content-Disposition'], /CLMS_Users_Export\.xlsx/)
  assert.ok(!/password/i.test(queries[0].sql.replace(/must_change_password/g, '')), 'query must not select a password column')
  const xml = sheetXml(r.body)
  for (const needle of ['ID Number', 'Surname', 'First Name', 'MI', 'Program', 'Role', '2026001', 'Cruz', 'Ana', 'BSIT-Teacher']) assert.ok(xml.includes(needle), needle)
  assert.ok(!xml.includes('SECRETHASH')); assert.deepEqual(queries[0].values, [5])
})
test('laboratories export uses the saved status / custom Others value and DB-formatted times', () => {
  const rows = [{ id: 1, laboratory_name: 'Laboratory 1', capacity: 40, status: 'UNAVAILABLE', status_other: 'Under renovation', available_from: '08:00', available_until: '17:00', reason: null }]
  const { mod, queries } = load(rows), r = res()
  mod.createDataExportController('laboratories')({ body: {} }, r)
  assert.equal(r.code, 200); const xml = sheetXml(r.body)
  for (const needle of ['Laboratory Name', 'Laboratory 1', 'Under renovation', '08:00', '17:00']) assert.ok(xml.includes(needle), needle)
  assert.ok(queries[0].sql.includes("DATE_FORMAT(unavailable_from, '%Y-%m-%d')"), 'dates are formatted by MySQL, no ISO timestamps'); assert.deepEqual(queries[0].values, [])
})
test('export rejects invalid or empty id lists', () => {
  for (const ids of ['x', [], ['a'], [-1]]) { const { mod } = load([]), r = res(); mod.createDataExportController('users')({ body: { ids } }, r); assert.equal(r.code, 400) }
})
test('user/laboratory export, bulk-delete and delete routes are MIS-only', () => {
  const order = []
  stub('../middleware/roleAuth.js', { requireRole: (...roles) => { order.push(roles); return (q, s, n) => n() } })
  for (const f of ['userRoutes', 'laboratoryRoutes']) {
    order.length = 0; const rp = path.resolve(__dirname, `../routes/${f}.js`); delete require.cache[rp]
    const router = require(rp)
    const layers = router.stack.filter(l => l.route)
    layers.forEach((layer, i) => { const key = `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`; if (['post /export', 'post /bulk-delete', 'delete /:id', 'post /import', 'post /import-preview'].includes(key)) assert.deepEqual(order[i], ['MIS'], `${f} ${key}`) })
    assert.ok(layers.some(l => l.route.path === '/export'), `${f} has export`)
  }
  delete require.cache[path.resolve(__dirname, '../middleware/roleAuth.js')]
})
