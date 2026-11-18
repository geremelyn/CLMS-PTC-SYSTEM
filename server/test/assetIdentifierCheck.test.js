'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { checkOtherAssetIdentifiers } = require('../utils/assetIdentifierCheck.js')

function queryResult(type, rows) {
  const calls = []
  const db = { query(sql, values, callback) { calls.push({ sql, values }); callback(null, rows) } }
  let result
  checkOtherAssetIdentifiers(db, type, 'TAG-1', 'SERIAL-1', (error, duplicate) => { result = { error, duplicate } })
  return { calls, result }
}

test('asset identifier check compares computers against equipment and flags cross-category collisions', () => {
  const { calls, result } = queryResult('computers', [{ id: 7 }])
  assert.match(calls[0].sql, /FROM equipment/)
  assert.match(calls[0].sql, /UPPER\(TRIM\(asset_tag\)\) = UPPER\(TRIM\(\?\)\)/)
  assert.match(calls[0].sql, /UPPER\(TRIM\(serial_number\)\) = UPPER\(TRIM\(\?\)\)/)
  assert.deepEqual(calls[0].values, ['TAG-1', 'SERIAL-1'])
  assert.equal(result.error, null)
  assert.equal(result.duplicate, true)
})

test('asset identifier check compares equipment against computers and accepts unique identifiers', () => {
  const { calls, result } = queryResult('equipment', [])
  assert.match(calls[0].sql, /FROM computers/)
  assert.equal(result.error, null)
  assert.equal(result.duplicate, false)
})

test('asset identifier check rejects unsupported categories without issuing SQL', () => {
  let called = false
  const result = checkOtherAssetIdentifiers({ query() { called = true } }, 'users', 'T', 'S', error => { assert.match(error.message, /unsupported/i) })
  assert.equal(result, undefined)
  assert.equal(called, false)
})
