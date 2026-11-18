const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function loadController({ error = null } = {}) {
  const calls = []
  const fakeDb = { query(sql, values, callback) { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values }); callback(error, { insertId: 7, affectedRows: 1 }) } }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const controllerPath = path.resolve(__dirname, '../controllers/laboratoryController.js')
  const fakeModule = new Module(dbPath); fakeModule.filename = dbPath; fakeModule.loaded = true; fakeModule.exports = fakeDb; require.cache[dbPath] = fakeModule
  delete require.cache[controllerPath]
  return { controller: require('../controllers/laboratoryController.js'), calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }
const base = { laboratory_name: ' Lab A ', capacity: '30', status: 'OPEN', available_from: '08:00', available_until: '17:00', booking_interval: '30' }

test('laboratory controller validates and persists normalized values', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.createLaboratory({ body: base }, response)
  assert.equal(response.code, 201)
  assert.equal(response.body.laboratory.laboratory_name, 'Lab A')
  assert.equal(response.body.laboratory.capacity, 30)
  assert.equal(response.body.laboratory.booking_interval, 30)
  assert.equal(calls[0].values[0], 'Lab A')
  assert.equal(calls[0].values[1], 30)
  assert.equal(calls[0].values[5], 30)
})
test('laboratory controller rejects invalid capacity before issuing SQL', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.createLaboratory({ body: { ...base, capacity: '-1' } }, response)
  assert.equal(response.code, 400)
  assert.match(response.body.message, /positive whole number/i)
  assert.equal(calls.length, 0)
})
test('laboratory controller uses centralized provisional fallback settings when legacy fields are absent', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  const body = { laboratory_name: 'Lab B', capacity: 20, status: 'OPEN' }
  controller.createLaboratory({ body }, response)
  assert.equal(response.code, 201)
  assert.equal(response.body.laboratory.available_from, '07:00:00')
  assert.equal(response.body.laboratory.available_until, '21:00:00')
  assert.equal(response.body.laboratory.booking_interval, 60)
  assert.equal(calls[0].values[3], '07:00:00')
  assert.equal(calls[0].values[4], '21:00:00')
  assert.equal(calls[0].values[5], 60)
})
test('laboratory controller maps duplicate-name database errors to conflict responses', () => {
  const { controller } = loadController({ error: Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }) }); const response = responseMock()
  controller.createLaboratory({ body: base }, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /already exists/i)
})
test('laboratory update uses centralized fallback values and validates before issuing SQL', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.updateLaboratory({ params: { id: '7' }, body: { laboratory_name: 'Lab C', capacity: 12, status: 'OPEN' } }, response)
  assert.equal(response.code, 200)
  assert.equal(response.body.laboratory.available_from, '07:00:00')
  assert.equal(response.body.laboratory.available_until, '21:00:00')
  assert.equal(calls[0].values[3], '07:00:00')
  assert.equal(calls[0].values[4], '21:00:00')
  assert.equal(calls[0].values[5], 60)
  assert.equal(calls[0].values[14], '7'); assert.equal(calls[0].values[13], null)
  const second = loadController(); const invalidResponse = responseMock()
  second.controller.updateLaboratory({ params: { id: '7' }, body: { laboratory_name: 'Lab C', capacity: 12, status: 'OPEN', available_from: '17:00', available_until: '08:00' } }, invalidResponse)
  assert.equal(invalidResponse.code, 400)
  assert.equal(second.calls.length, 0)
})

// ---- Group 2: Others status + Reason (MOCKED db: no MySQL/MariaDB involved) ----
const others = { laboratory_name: 'Lab O', capacity: 20, status: 'OTHERS', status_other: 'Under renovation', reason: '  New roof being installed ' }
test('Group 2: creating a laboratory with Others and a reason succeeds and persists status_other + reason', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.createLaboratory({ body: others }, response)
  assert.equal(response.code, 201, JSON.stringify(response.body))
  assert.match(calls[0].sql, /INSERT INTO laboratories/)
  assert.equal(calls[0].values[2], 'UNAVAILABLE')
  assert.equal(calls[0].values[12], 'New roof being installed')
  assert.equal(calls[0].values[13], 'Under renovation')
  assert.equal(response.body.laboratory.reason, 'New roof being installed')
  assert.equal(response.body.laboratory.status_other, 'Under renovation')
})
test('Group 2: Others without a reason is a clean 400 (no SQL), never a 500', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.createLaboratory({ body: { ...others, reason: '' } }, response)
  assert.equal(response.code, 400); assert.match(response.body.message, /reason/i); assert.equal(calls.length, 0)
})
test('Group 2: updating a laboratory to Others saves the reason; switching back to OPEN clears it', () => {
  let ctx = loadController(); let response = responseMock()
  ctx.controller.updateLaboratory({ params: { id: '7' }, body: others }, response)
  assert.equal(response.code, 200, JSON.stringify(response.body))
  assert.equal(ctx.calls[0].values[12], 'New roof being installed'); assert.equal(ctx.calls[0].values[13], 'Under renovation')
  assert.equal(response.body.laboratory.reason, 'New roof being installed'); assert.equal(response.body.laboratory.status_other, 'Under renovation')
  ctx = loadController(); response = responseMock()
  ctx.controller.updateLaboratory({ params: { id: '7' }, body: { laboratory_name: 'Lab O', capacity: 20, status: 'OPEN', reason: 'stale' } }, response)
  assert.equal(response.code, 200); assert.equal(ctx.calls[0].values[12], null); assert.equal(ctx.calls[0].values[13], null)
})
test('Group 2: plain UNAVAILABLE still requires a reason and still saves it', () => {
  let ctx = loadController(); let response = responseMock()
  ctx.controller.createLaboratory({ body: { laboratory_name: 'Lab U', capacity: 10, status: 'UNAVAILABLE' } }, response)
  assert.equal(response.code, 400)
  ctx = loadController(); response = responseMock()
  ctx.controller.createLaboratory({ body: { laboratory_name: 'Lab U', capacity: 10, status: 'UNAVAILABLE', reason: 'Flooded' } }, response)
  assert.equal(response.code, 201); assert.equal(ctx.calls[0].values[12], 'Flooded'); assert.equal(ctx.calls[0].values[13], null)
})
test('Group 2: laboratory routes expose MIS-only bulk-delete backed by the safe Recycle Bin delete', () => {
  const fs = require('node:fs'); const text = fs.readFileSync(path.resolve(__dirname, '../routes/laboratoryRoutes.js'), 'utf8')
  assert.match(text, /router\.post\('\/bulk-delete', requireRole\('MIS'\), deleteLaboratories\)/)
})

test('CP174: update persists the booking interval it is given (saved value is not reset to the default) and returns it', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.updateLaboratory({ params: { id: '3' }, body: { ...base, booking_interval: '45' } }, response)
  assert.equal(response.code, 200)
  assert.match(calls[0].sql, /booking_interval = \?/)
  assert.ok(calls[0].values.includes(45) && !calls[0].values.includes(60))
  assert.equal(response.body.laboratory.booking_interval, 45)
})
test('CP174: create/update with a malformed date or a reversed range is a clean 400 with no SQL', () => {
  for (const method of ['createLaboratory', 'updateLaboratory']) {
    let { controller, calls } = loadController(); let response = responseMock()
    controller[method]({ params: { id: '3' }, body: { ...base, available_date_from: '2026-02-30' } }, response)
    assert.equal(response.code, 400); assert.match(response.body.message, /valid dates in YYYY-MM-DD format/i); assert.equal(calls.length, 0)
    ;({ controller, calls } = loadController()); response = responseMock()
    controller[method]({ params: { id: '3' }, body: { ...base, available_date_from: '2026-12-01', available_date_until: '2026-11-01' } }, response)
    assert.equal(response.code, 400); assert.match(response.body.message, /ending date must be on or after the starting date/i); assert.equal(calls.length, 0)
  }
})
test('CP174: a bad booking interval is a clean 400 with no SQL', () => {
  const { controller, calls } = loadController(); const response = responseMock()
  controller.updateLaboratory({ params: { id: '3' }, body: { ...base, booking_interval: '0' } }, response)
  assert.equal(response.code, 400); assert.match(response.body.message, /booking interval/i); assert.equal(calls.length, 0)
})

test('CP178 A1: creating / updating a laboratory without hours stores the 07:00-21:00 fallback (and keeps explicit hours)', () => {
  let ctx = loadController(); let response = responseMock()
  ctx.controller.createLaboratory({ body: { laboratory_name: 'Lab Fallback', capacity: 10, status: 'OPEN' } }, response)
  assert.equal(response.code, 201, JSON.stringify(response.body)); assert.equal(ctx.calls[0].values[3], '07:00:00'); assert.equal(ctx.calls[0].values[4], '21:00:00')
  assert.equal(response.body.laboratory.available_from, '07:00:00'); assert.equal(response.body.laboratory.available_until, '21:00:00')
  ctx = loadController(); response = responseMock()
  ctx.controller.createLaboratory({ body: { laboratory_name: 'Lab Explicit', capacity: 10, status: 'OPEN', available_from: '09:00', available_until: '15:00' } }, response)
  assert.equal(response.code, 201); assert.match(String(ctx.calls[0].values[3]), /^09:00/); assert.match(String(ctx.calls[0].values[4]), /^15:00/)
  ctx = loadController(); response = responseMock()
  ctx.controller.updateLaboratory({ params: { id: '3' }, body: { laboratory_name: 'Lab Fallback', capacity: 10, status: 'OPEN' } }, response)
  assert.equal(response.code, 200, JSON.stringify(response.body)); assert.equal(ctx.calls[0].values[3], '07:00:00'); assert.equal(ctx.calls[0].values[4], '21:00:00')
})
