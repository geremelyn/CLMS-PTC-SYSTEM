const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const configPath = path.resolve(__dirname, '../config/reservationPolicy.js')
function loadPolicy(overrides = {}) {
  const env = { ...process.env }
  for (const key of ['CLMS_RESERVATION_CUTOFF_DAYS','CLMS_BLOCK_SUNDAY','CLMS_FALLBACK_LAB_OPEN','CLMS_FALLBACK_LAB_CLOSE','CLMS_DEFAULT_BOOKING_INTERVAL','CLMS_CONFLICT_STATUSES']) delete env[key]
  Object.assign(env, overrides)
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)})))`], { env, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}
test('provisional reservation policy defaults are explicit and centralized', () => {
  const policy = loadPolicy()
  assert.equal(policy.approvalCutoffDays, 3)
  assert.equal(policy.blockSunday, true)
  // CP178 A1: fallback laboratory hours follow the operating hours (07:00-21:00); this test used to expect 08:00-17:00.
  assert.equal(policy.fallbackLabOpeningTime, '07:00:00')
  assert.equal(policy.fallbackLabClosingTime, '21:00:00')
  assert.equal(policy.defaultBookingInterval, 60)
  assert.deepEqual(policy.conflictStatuses, ['PENDING', 'APPROVED'])
  assert.match(policy.confirmationStatus, /UNCONFIRMED/i)
})
test('provisional reservation policy can be overridden with validated environment settings', () => {
  const policy = loadPolicy({ CLMS_RESERVATION_CUTOFF_DAYS: '5', CLMS_BLOCK_SUNDAY: 'false', CLMS_FALLBACK_LAB_OPEN: '07:30', CLMS_FALLBACK_LAB_CLOSE: '19:00', CLMS_DEFAULT_BOOKING_INTERVAL: '30', CLMS_CONFLICT_STATUSES: 'PENDING,APPROVED,COMPLETED,invalid' })
  assert.equal(policy.approvalCutoffDays, 5)
  assert.equal(policy.blockSunday, false)
  assert.equal(policy.fallbackLabOpeningTime, '07:30:00')
  assert.equal(policy.fallbackLabClosingTime, '19:00:00')
  assert.equal(policy.defaultBookingInterval, 30)
  assert.deepEqual(policy.conflictStatuses, ['PENDING', 'APPROVED', 'COMPLETED'])
})
test('invalid policy environment values fall back to safe validated defaults', () => {
  const policy = loadPolicy({ CLMS_RESERVATION_CUTOFF_DAYS: '-4', CLMS_FALLBACK_LAB_OPEN: '26:99', CLMS_FALLBACK_LAB_CLOSE: '05:00', CLMS_DEFAULT_BOOKING_INTERVAL: '0' })
  assert.equal(policy.approvalCutoffDays, 3)
  assert.equal(policy.fallbackLabOpeningTime, '07:00:00')
  assert.equal(policy.fallbackLabClosingTime, '21:00:00')
  assert.equal(policy.defaultBookingInterval, 60)
})

test('CP178 A1: fallback laboratory hours are derived from the operating hours config (one source) and env overrides still work', () => {
  const fs = require('node:fs'), path = require('node:path')
  const operating = require('../config/reservationTime.js')
  delete require.cache[require.resolve('../config/reservationPolicy.js')]
  const base = require('../config/reservationPolicy.js')
  assert.equal(base.fallbackLabOpeningTime, `${operating.OPEN}:00`); assert.equal(base.fallbackLabClosingTime, `${operating.CLOSE}:00`)
  const src = fs.readFileSync(path.join(__dirname, '../config/reservationPolicy.js'), 'utf8')
  assert.doesNotMatch(src, /'08:00:00'|'17:00:00'/) // no stale hard-coded 08:00-17:00 left
  process.env.CLMS_FALLBACK_LAB_OPEN = '09:00'; process.env.CLMS_FALLBACK_LAB_CLOSE = '18:30'
  try { delete require.cache[require.resolve('../config/reservationPolicy.js')]; const o = require('../config/reservationPolicy.js'); assert.equal(o.fallbackLabOpeningTime, '09:00:00'); assert.equal(o.fallbackLabClosingTime, '18:30:00') }
  finally { delete process.env.CLMS_FALLBACK_LAB_OPEN; delete process.env.CLMS_FALLBACK_LAB_CLOSE; delete require.cache[require.resolve('../config/reservationPolicy.js')] }
})
test('CP178 A1: a laboratory with no hours of its own accepts 07:00-09:00 and 20:00-21:00 and rejects outside 07:00-21:00', () => {
  // exercised through the schema/default constants used by laboratory create/update and reservation validation
  delete require.cache[require.resolve('../config/reservationPolicy.js')]
  const p = require('../config/reservationPolicy.js')
  const within = (s, e) => s >= p.fallbackLabOpeningTime.slice(0, 5) && e <= p.fallbackLabClosingTime.slice(0, 5)
  assert.ok(within('07:00', '09:00')); assert.ok(within('20:00', '21:00')); assert.ok(!within('06:30', '08:00')); assert.ok(!within('20:30', '21:30'))
})
