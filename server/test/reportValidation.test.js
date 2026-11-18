const test = require('node:test')
const assert = require('node:assert/strict')
const { validDateString, validateLaboratoryFilter, validateAuditReportFilters } = require('../utils/reportValidation.js')

test('validates calendar dates exactly instead of accepting normalized impossible dates', () => {
  assert.equal(validDateString('2026-02-28'), true)
  assert.equal(validDateString('2026-02-30'), false)
  assert.equal(validDateString('2026-2-3'), false)
})
test('rejects malformed laboratory report filters instead of silently dropping them', () => {
  assert.deepEqual(validateLaboratoryFilter(''), { error: null, id: null })
  assert.deepEqual(validateLaboratoryFilter('12'), { error: null, id: 12 })
  assert.match(validateLaboratoryFilter('abc').error, /positive laboratory ID/i)
  assert.match(validateLaboratoryFilter('0').error, /positive laboratory ID/i)
  assert.match(validateLaboratoryFilter('1.5').error, /positive laboratory ID/i)
})
test('validates audit report role, user ID, dates and date ordering', () => {
  assert.equal(validateAuditReportFilters({ role: 'MIS', user_id: '0', from: '2026-01-01', to: '2026-01-31' }).error, null)
  assert.match(validateAuditReportFilters({ role: 'Super Admin' }).error, /invalid role/i)
  assert.match(validateAuditReportFilters({ user_id: '-1' }).error, /non-negative whole number/i)
  assert.match(validateAuditReportFilters({ from: '2026-02-30' }).error, /valid dates/i)
  assert.match(validateAuditReportFilters({ from: '2026-03-01', to: '2026-02-28' }).error, /on or before/i)
})
