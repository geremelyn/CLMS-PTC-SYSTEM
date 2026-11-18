const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeRecordIds } = require('../utils/bulkRecordValidation.js')

test('normalizes and de-duplicates positive record IDs', () => {
  assert.deepEqual(normalizeRecordIds([1, '2', 2, '003']), [1, 2, 3])
})
test('rejects invalid, empty, non-integer, unsafe, or non-array record ID input', () => {
  for (const value of [null, '1', [], [0], [-1], ['1x'], [1.5], ['9007199254740992'], [1, 'bad']]) {
    assert.deepEqual(normalizeRecordIds(value), [])
  }
})
