// CP72: plain-language import error helper (pure functions, no DOM, no database, no HTTP).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/importErrors.js')).href)

test('row messages are classified, keep the original text and add a fix hint', async () => {
  const { explainRowError } = await load()
  const cases = [
    ['Laboratory name is required.', 'Missing required field', /“Laboratory name” column/],
    ['Condition note is required unless condition is WORKING.', 'Missing required field', /WORKING/],
    ['Asset tag “PC-1” already exists in the database.', 'Already in the system', /unique/],
    ['Serial number duplicates row 4 in this file.', 'Repeated in this file', /more than once/],
    ['Duplicate of an earlier row in this file.', 'Repeated in this file', /more than once/],
    ['Laboratory reached its limit.', 'Laboratory is full', /capacity/],
    ['Laboratory ID 99 does not exist.', 'Invalid value', /No saved record/],
    ['condition “Odd” is not a configured option.', 'Unsupported value', /dropdown/],
    ['Computer assignment must belong to the selected laboratory.', 'Invalid value', /same row/],
    ['ID number “2024-1” already exists.', 'Already in the system', /unique/]
  ]
  for (const [raw, kind, tip] of cases) { const x = explainRowError(raw); assert.equal(x.kind, kind, raw); assert.equal(x.message, raw, 'original text kept'); assert.match(x.tip, tip, raw) }
})
test('technical-looking row text is replaced by a plain message, never shown raw', async () => {
  const { explainRowError } = await load()
  for (const raw of ['ER_DUP_ENTRY: Duplicate entry', 'TypeError: Cannot read properties of undefined', 'SQLSTATE[23000]']) { const x = explainRowError(raw); assert.equal(x.message, 'Something in this row could not be checked.'); assert.ok(!/ER_|TypeError|SQLSTATE/.test(x.message + x.tip)) }
})
test('summary counts problem types and says nothing was saved; details keep row numbers', async () => {
  const { summarizeRowProblems, describeRowDetails } = await load()
  const rows = [{ rowNumber: 2, valid: false, errors: ['Asset tag is required.'] }, { rowNumber: 3, valid: false, errors: ['Asset tag “A” already exists in the database.', 'Serial number is required.'] }, { rowNumber: 4, valid: true, errors: [] }]
  const summary = summarizeRowProblems(rows)
  assert.match(summary, /2 rows need correction/); assert.match(summary, /2 × missing required field/); assert.match(summary, /1 × already in the system/); assert.match(summary, /Nothing has been saved/)
  assert.match(summarizeRowProblems([rows[0]]), /1 row needs correction/)
  const details = describeRowDetails(rows.slice(0, 2)).split('\n')
  assert.equal(details.length, 2); assert.match(details[0], /^Row 2: Missing required field — Asset tag is required\./); assert.match(details[1], /^Row 3: .*Already in the system — Asset tag “A” already exists/)
})
test('request failures: network, timeout, auth, size, server text kept, 5xx, unknown', async () => {
  const { describeRequestFailure } = await load()
  const net = describeRequestFailure(new Error('Network Error'), 'preview'); assert.match(net, /Can't reach the server/); assert.match(net, /Nothing has been saved/); assert.ok(!/Network Error/.test(net))
  assert.match(describeRequestFailure(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }), 'import'), /took too long.*importing.*No rows were saved/)
  assert.match(describeRequestFailure(new Error('Unable to read selected workbook.')), /could not be read/)
  assert.match(describeRequestFailure({ response: { status: 401, data: {} } }), /session has expired/)
  assert.match(describeRequestFailure({ response: { status: 403, data: { message: 'Forbidden' } } }), /not allowed/)
  assert.match(describeRequestFailure({ response: { status: 413, data: {} } }), /5 MB/)
  assert.equal(describeRequestFailure({ response: { status: 409, data: { message: 'Import stopped because a record now duplicates a saved one. No rows were saved.' } } }, 'import'), 'Import stopped because a record now duplicates a saved one. No rows were saved.')
  assert.match(describeRequestFailure({ response: { status: 400, data: { message: 'Provide between 1 and 500 rows to import.' } } }, 'import'), /^Provide between 1 and 500 rows to import\. No rows were saved\.$/)
  const five = describeRequestFailure({ response: { status: 500, data: {} } }, 'preview'); assert.match(five, /server had a problem.*checking/); assert.ok(!/500/.test(five))
  const raw = describeRequestFailure({ response: { status: 500, data: { message: 'ER_BAD_FIELD_ERROR: Unknown column' } } }, 'import'); assert.ok(!/ER_BAD/.test(raw)); assert.match(raw, /No rows were saved/)
  assert.match(describeRequestFailure({ response: { status: 422, data: {} } }, 'preview'), /CLMS template/)
})
