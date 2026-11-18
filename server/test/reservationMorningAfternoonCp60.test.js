// CP60 - Morning / Afternoon time filtering on the Dean/Teacher reservation form.
// UNIT (real execution): the pure option builders in client/src/utils/reservationTime.js.
// SOURCE-LEVEL: Reservations.jsx wiring/text is checked by reading the file (no React render, no browser).
// Conflict validation is NOT re-implemented here: it is covered by the existing MOCKED (reservationCustomTimeCp24 /
// reservationCreateController) and SQLite (overlapSqlReal, reservationTimeOverlap) suites, which must still pass.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const helpers = () => import(pathToFileURL(path.resolve(__dirname, '../../client/src/utils/reservationTime.js')).href)
const page = () => fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Reservations.jsx'), 'utf8')
const minutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3))

test('Morning: start options are AM only from 7:00 AM; end options run to 12:00 PM (the only non-AM value, as an end point)', async () => {
  const h = await helpers()
  const starts = h.startOptionsForPeriod('MORNING'), ends = h.endOptionsForPeriod('MORNING', '')
  assert.equal(starts[0], '07:00'); assert.equal(starts.at(-1), '11:30')
  assert.ok(starts.every(o => h.formatTimeLabel(o).endsWith('AM')), 'no PM start in Morning')
  assert.equal(ends[0], '07:30'); assert.equal(ends.at(-1), '12:00'); assert.equal(h.formatTimeLabel(ends.at(-1)), '12:00 PM')
  assert.ok(ends.slice(0, -1).every(o => h.formatTimeLabel(o).endsWith('AM')))
  assert.ok(!ends.some(o => o > '12:00') && !starts.includes('12:00'))
})

test('Afternoon: start and end options are PM only, from 12:00 PM to 9:00 PM', async () => {
  const h = await helpers()
  const starts = h.startOptionsForPeriod('AFTERNOON'), ends = h.endOptionsForPeriod('AFTERNOON', '')
  assert.equal(starts[0], '12:00'); assert.equal(starts.at(-1), '20:30')
  assert.equal(ends[0], '12:30'); assert.equal(ends.at(-1), '21:00')
  assert.ok([...starts, ...ends].every(o => h.formatTimeLabel(o).endsWith('PM')), 'no AM option in Afternoon')
})

test('30-minute increments are kept in both lists, and the whole day stays 7:00 AM - 9:00 PM', async () => {
  const h = await helpers()
  assert.equal(h.RESERVATION_STEP_MINUTES, 30)
  for (const period of ['MORNING', 'AFTERNOON']) for (const list of [h.startOptionsForPeriod(period), h.endOptionsForPeriod(period, '')]) {
    for (let i = 1; i < list.length; i++) assert.equal(minutes(list[i]) - minutes(list[i - 1]), 30, `${period} step`)
    assert.ok(list.every(o => minutes(o) % 30 === 0))
  }
  const all = [...new Set([...h.startOptionsForPeriod('MORNING'), ...h.endOptionsForPeriod('MORNING', ''), ...h.startOptionsForPeriod('AFTERNOON'), ...h.endOptionsForPeriod('AFTERNOON', '')])].sort()
  assert.equal(all[0], '07:00'); assert.equal(all.at(-1), '21:00'); assert.deepEqual(all, h.TIME_OPTIONS)
  assert.equal(h.RESERVATION_OPEN, '07:00'); assert.equal(h.RESERVATION_CLOSE, '21:00'); assert.equal(h.TIME_OPTIONS.length, 29)
})

test('end options always come after the chosen start and stay inside the chosen part of the day', async () => {
  const h = await helpers()
  assert.deepEqual(h.endOptionsForPeriod('MORNING', '10:00'), ['10:30', '11:00', '11:30', '12:00'])
  assert.deepEqual(h.endOptionsForPeriod('MORNING', '11:30'), ['12:00'])
  assert.deepEqual(h.endOptionsForPeriod('AFTERNOON', '20:00'), ['20:30', '21:00'])
  assert.deepEqual(h.endOptionsForPeriod('AFTERNOON', '20:30'), ['21:00'])
})

test('switching Morning <-> Afternoon swaps the lists with no overlap of AM/PM values (except the shared 12:00 boundary)', async () => {
  const h = await helpers()
  const m = new Set([...h.startOptionsForPeriod('MORNING'), ...h.endOptionsForPeriod('MORNING', '')])
  const a = new Set([...h.startOptionsForPeriod('AFTERNOON'), ...h.endOptionsForPeriod('AFTERNOON', '')])
  assert.deepEqual([...m].filter(x => a.has(x)), ['12:00'], 'only the noon boundary (Morning end = Afternoon start)')
  assert.ok(!h.startOptionsForPeriod('MORNING').some(o => a.has(o)), 'a Morning START is never in the Afternoon lists')
  assert.ok(![...a].some(o => o < '12:00') && ![...m].some(o => o > '12:00'))
})

test('page wiring: Morning/Afternoon filter both lists, switching resets stale times, labels are plain, "30-minute steps" text is gone', () => {
  const src = page()
  assert.match(src, /startOptionsForPeriod\(selectedPeriod\)/); assert.match(src, /endOptionsForPeriod\(selectedPeriod, startTime\)/)
  assert.match(src, /if \(key !== selectedPeriod\) \{ setSelectedPeriod\(key\); setStartTime\(''\); setEndTime\(''\) \}/, 'switching clears times that may not exist in the new list')
  assert.doesNotMatch(src, /30-minute/i); assert.doesNotMatch(src, /START_OPTIONS|endOptionsFor\(/)
  const button = src.slice(src.indexOf('Object.entries(PERIOD_PRESETS)'), src.indexOf('</button>', src.indexOf('Object.entries(PERIOD_PRESETS)')))
  assert.match(button, /<strong>\{preset\.label\}<\/strong>/); assert.doesNotMatch(button, /formatTimeLabel|<span>/, 'button shows only Morning / Afternoon')
  assert.doesNotMatch(src, /setSelectedPeriod\(''\)/, 'a manual time change no longer drops the Morning/Afternoon selection')
})

test('page keeps the existing submission flow: required times, end after start, confirm, same API payload', () => {
  const src = page()
  assert.match(src, /if \(!startTime \|\| !endTime\)/); assert.match(src, /endTime <= startTime/)
  assert.match(src, /start_time: startTime,\s*end_time: endTime/); assert.match(src, /Submit reservation/)
})

test('server-side hours/validation config is untouched (7:00 AM - 9:00 PM, 30 minutes)', () => {
  const cfg = fs.readFileSync(path.resolve(__dirname, '../config/reservationTime.js'), 'utf8')
  assert.match(cfg, /07:00/); assert.match(cfg, /21:00/); assert.match(cfg, /30/)
})
