const test = require('node:test')
const assert = require('node:assert/strict')
const { positiveInteger, requiredText, conditionNoteError } = require('../utils/recordValidation.js')

test('positiveInteger accepts positive integer values and numeric IDs', () => {
  assert.equal(positiveInteger(4), 4)
  assert.equal(positiveInteger('004'), 4)
  assert.equal(positiveInteger('1'), 1)
})

test('positiveInteger rejects empty, zero, fractional, unsafe, and malformed IDs', () => {
  for (const value of ['', '  ', '0', 0, -1, '1.5', 1.5, '1x', '9007199254740992', null, undefined]) {
    assert.equal(positiveInteger(value), null, `expected ${String(value)} to be rejected`)
  }
})

test('requiredText rejects blank values and accepts trimmed non-empty strings', () => {
  assert.equal(requiredText('  '), false)
  assert.equal(requiredText(''), false)
  assert.equal(requiredText(null), false)
  assert.equal(requiredText(' Asset '), true)
})

test('condition note is required for repair, damaged, missing, and retired records', () => {
  for (const status of ['UNDER REPAIR', 'DAMAGED', 'MISSING', 'RETIRED']) {
    assert.match(conditionNoteError(status, ' '), /condition note is required/i)
    assert.equal(conditionNoteError(status, 'Needs inspection'), null)
  }
})

test('condition note remains optional for working status and status matching is case-insensitive', () => {
  assert.equal(conditionNoteError('WORKING', ''), null)
  assert.match(conditionNoteError('damaged', ''), /condition note is required/i)
})

test('custom non-working conditions require an explanatory note', () => {
  assert.match(conditionNoteError('CALIBRATING', ''), /note is required/i)
  assert.equal(conditionNoteError('CALIBRATING', 'Pending inspection'), null)
})
