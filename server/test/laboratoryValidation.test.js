const test = require('node:test')
const assert = require('node:assert/strict')
const { validateLaboratoryInput, normalizeTime } = require('../utils/laboratoryValidation.js')
const valid = { laboratory_name: ' Lab A ', capacity: '30', status: 'OPEN', available_from: '08:00', available_until: '17:00', booking_interval: '60' }

test('normalizes a valid laboratory name, capacity, status, interval, and explicit times', () => {
  const result = validateLaboratoryInput(valid)
  assert.equal(result.error, null)
  assert.deepEqual(result.values, { laboratory_name: 'Lab A', capacity: 30, status: 'OPEN', status_other: null, reason: null, booking_interval: 60, available_from: '08:00:00', available_until: '17:00:00' })
})
test('rejects blank names, non-positive/non-integer capacity, and invalid status', () => {
  assert.match(validateLaboratoryInput({ ...valid, laboratory_name: ' ' }).error, /name is required/i)
  assert.match(validateLaboratoryInput({ ...valid, laboratory_name: 'x'.repeat(101) }).error, /100 characters or fewer/i)
  assert.match(validateLaboratoryInput({ ...valid, capacity: '2.5' }).error, /positive whole number/i)
  assert.match(validateLaboratoryInput({ ...valid, capacity: '0' }).error, /positive whole number/i)
  assert.match(validateLaboratoryInput({ ...valid, status: 'UNKNOWN' }).error, /valid laboratory status/i)
})
test('rejects incomplete or invalid opening hours and closing time not later than opening', () => {
  assert.match(validateLaboratoryInput({ ...valid, available_from: '08:00', available_until: '' }).error, /both valid opening and closing times/i)
  assert.match(validateLaboratoryInput({ ...valid, available_from: '25:00' }).error, /valid opening and closing times/i)
  assert.match(validateLaboratoryInput({ ...valid, available_from: '17:00', available_until: '08:00' }).error, /later than available from/i)
  assert.equal(normalizeTime('09:30'), '09:30:00')
  assert.equal(normalizeTime('invalid'), undefined)
})
test('requires a reason for unavailable laboratories and validates booking interval', () => {
  assert.match(validateLaboratoryInput({ ...valid, status: 'UNAVAILABLE', reason: '' }).error, /reason is required/i)
  assert.match(validateLaboratoryInput({ ...valid, booking_interval: '-1' }).error, /booking interval/i)
})

test('Others status stores UNAVAILABLE plus the custom label and requires the label', () => {
  const { validateLaboratoryInput } = require('../utils/laboratoryValidation.js')
  const ok = validateLaboratoryInput({ laboratory_name: 'Lab A', capacity: 30, status: 'OTHERS', status_other: '  Under renovation ', reason: ' Roof repair ' })
  assert.equal(ok.error, null); assert.equal(ok.values.status, 'UNAVAILABLE'); assert.equal(ok.values.status_other, 'Under renovation'); assert.equal(ok.values.reason, 'Roof repair')
  assert.ok(validateLaboratoryInput({ laboratory_name: 'Lab A', capacity: 30, status: 'OTHERS', status_other: '  ' }).error)
  assert.ok(validateLaboratoryInput({ laboratory_name: 'Lab A', capacity: 30, status: 'UNAVAILABLE' }).error, 'plain Unavailable still requires a reason')
})

test('Group 2: Others now requires a Reason (trimmed, max 255) and non-Others statuses never keep one', () => {
  const others = { laboratory_name: 'Lab A', capacity: 30, status: 'OTHERS', status_other: 'Under renovation' }
  assert.match(validateLaboratoryInput(others).error, /reason/i)
  assert.match(validateLaboratoryInput({ ...others, reason: '   ' }).error, /reason/i)
  assert.match(validateLaboratoryInput({ ...others, reason: 'x'.repeat(256) }).error, /255/)
  assert.equal(validateLaboratoryInput({ ...others, reason: 'x'.repeat(255) }).error, null)
  assert.equal(validateLaboratoryInput({ laboratory_name: 'Lab A', capacity: 30, status: 'OPEN', reason: 'ignored' }).values.reason, null)
  assert.equal(validateLaboratoryInput({ laboratory_name: 'Lab A', capacity: 30, status: 'UNAVAILABLE', reason: 'Flooded' }).values.reason, 'Flooded')
  // Excel import keeps its previous leniency (explicit option), the form/API default does not.
  assert.equal(validateLaboratoryInput(others, { requireOthersReason: false }).error, null)
})

// ---- CP174 Part 2: malformed dates, start-after-end, booking interval
test('CP174: malformed or impossible dates are rejected with a clear message (active status range only)', () => {
  const msg = /valid dates in YYYY-MM-DD format/i
  for (const bad of ['tomorrow', '2026-13-01', '2026-02-30', '2026-02-29', '2026-1-5', '11/30/2026', '2026-11-01T00:00:00Z', ' 2026-11-01', 20261101]) {
    assert.match(validateLaboratoryInput({ ...valid, available_date_from: bad }).error, msg, `OPEN from=${String(bad)}`)
    assert.match(validateLaboratoryInput({ ...valid, available_date_until: bad }).error, msg, `OPEN until=${String(bad)}`)
  }
  assert.match(validateLaboratoryInput({ ...valid, status: 'UNAVAILABLE', reason: 'Repairs', unavailable_from: '2026-02-30', unavailable_until: '2026-03-01' }).error, msg)
  assert.match(validateLaboratoryInput({ ...valid, status: 'USED', used_from: '2026-03-01', used_until: 'abc' }).error, msg)
  // a malformed value in a range that is NOT saved for this status is ignored (the server nulls it anyway)
  assert.equal(validateLaboratoryInput({ ...valid, status: 'OPEN', used_from: 'garbage' }).error, null)
})
test('CP174: valid, leap-day, empty and null dates are accepted', () => {
  assert.equal(validateLaboratoryInput({ ...valid, available_date_from: '2026-11-01', available_date_until: '2026-11-30' }).error, null)
  assert.equal(validateLaboratoryInput({ ...valid, available_date_from: '2024-02-29' }).error, null)
  assert.equal(validateLaboratoryInput({ ...valid, available_date_from: '', available_date_until: null }).error, null)
  assert.equal(validateLaboratoryInput({ ...valid, available_date_from: '2026-11-30', available_date_until: '2026-11-30' }).error, null)
})
test('CP174: start date after end date is rejected for OPEN, UNAVAILABLE and USED, with its own message', () => {
  const msg = /ending date must be on or after the starting date/i
  assert.match(validateLaboratoryInput({ ...valid, available_date_from: '2026-12-01', available_date_until: '2026-11-01' }).error, msg)
  assert.match(validateLaboratoryInput({ ...valid, status: 'UNAVAILABLE', reason: 'x', unavailable_from: '2026-12-01', unavailable_until: '2026-11-01' }).error, msg)
  assert.match(validateLaboratoryInput({ ...valid, status: 'USED', used_from: '2026-12-01', used_until: '2026-11-01' }).error, msg)
})
test('CP174: booking interval accepts positive whole minutes, defaults to 60 only when omitted, rejects everything else', () => {
  assert.equal(validateLaboratoryInput({ ...valid, booking_interval: '45' }).values.booking_interval, 45)
  assert.equal(validateLaboratoryInput({ ...valid, booking_interval: 30 }).values.booking_interval, 30)
  assert.equal(validateLaboratoryInput({ ...valid, booking_interval: '' }).values.booking_interval, 60)
  const { booking_interval, ...noInterval } = valid
  assert.equal(validateLaboratoryInput(noInterval).values.booking_interval, 60)
  for (const bad of ['0', '-5', '1.5', '1e2', 'abc', '30 min', 0, -1, 2.5]) assert.match(validateLaboratoryInput({ ...valid, booking_interval: bad }).error, /booking interval must be a positive whole number of minutes/i, String(bad))
})
