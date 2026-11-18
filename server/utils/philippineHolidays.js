'use strict'
// Philippine holiday rules for CLMS. Pure functions only (no DB, no Express) so they are unit-testable and
// reusable by the reservation controller, the holiday controller and the schema seeder.
//
// Timezone: every "today" decision uses Asia/Manila (never the server's local timezone). Calendar-date
// arithmetic works on plain YYYY-MM-DD strings via UTC so it cannot shift with the host timezone.

const TIMEZONE = 'Asia/Manila'

const HOLIDAY_TYPES = Object.freeze({
  REGULAR: 'REGULAR',
  SPECIAL_NON_WORKING: 'SPECIAL_NON_WORKING',
  SPECIAL_WORKING: 'SPECIAL_WORKING',
  OTHER: 'OTHER' // custom type typed by the Super Admin (stored label in custom_type_label)
})
const HOLIDAY_TYPE_LABELS = Object.freeze({
  REGULAR: 'Regular Holiday',
  SPECIAL_NON_WORKING: 'Special Non-Working Day',
  SPECIAL_WORKING: 'Special Working Day',
  OTHER: 'Others'
})
// Regular holidays and special NON-working days close the laboratories. A special WORKING day stays bookable.
// A custom (Others) holiday is also a non-working day, so it closes the laboratories as well.
const BLOCKING_TYPES = Object.freeze([HOLIDAY_TYPES.REGULAR, HOLIDAY_TYPES.SPECIAL_NON_WORKING, HOLIDAY_TYPES.OTHER])

const R = HOLIDAY_TYPES.REGULAR, S = HOLIDAY_TYPES.SPECIAL_NON_WORKING, W = HOLIDAY_TYPES.SPECIAL_WORKING
const P1006 = 'Proclamation No. 1006, s. 2025 (signed Sept 3, 2025; Official Gazette)'
const P1189 = 'Proclamation No. 1189, s. 2026 (signed Mar 12, 2026; lawphil.net)'
const P1264 = 'Proclamation No. 1264, s. 2026 (signed May 21, 2026; lawphil.net)'
const P1447 = 'Proclamation No. 1447, s. 2026 (signed Sept 17, 2026; Official Gazette) - National Capital Region only'
const P1427 = 'Proclamation No. 1427, s. 2026 (signed Sept 8, 2026; Official Gazette / PCO / PNA)'

// 2026: checked against the primary texts of Proclamation Nos. 1006, 1189 and 1264 on 2026-11-02.
// Eid'l Fitr / Eid'l Adha are movable and were proclaimed separately (see Proc. 1006 Sec. 2).
const VERIFIED_HOLIDAYS = Object.freeze({
  2026: Object.freeze([
    { holiday_date: '2026-01-01', name: "New Year's Day", holiday_type: R, source: P1006 },
    { holiday_date: '2026-02-17', name: 'Chinese New Year', holiday_type: S, source: P1006 },
    { holiday_date: '2026-02-25', name: 'EDSA People Power Revolution Anniversary', holiday_type: W, source: P1006 },
    { holiday_date: '2026-03-20', name: "Eid'l Fitr", holiday_type: R, source: P1189 },
    { holiday_date: '2026-04-02', name: 'Maundy Thursday', holiday_type: R, source: P1006 },
    { holiday_date: '2026-04-03', name: 'Good Friday', holiday_type: R, source: P1006 },
    { holiday_date: '2026-04-04', name: 'Black Saturday', holiday_type: S, source: P1006 },
    { holiday_date: '2026-04-09', name: 'Araw ng Kagitingan', holiday_type: R, source: P1006 },
    { holiday_date: '2026-05-01', name: 'Labor Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-05-27', name: "Eid'l Adha", holiday_type: R, source: P1264 },
    { holiday_date: '2026-06-12', name: 'Independence Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-08-21', name: 'Ninoy Aquino Day', holiday_type: S, source: P1006 },
    { holiday_date: '2026-08-31', name: 'National Heroes Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-11-01', name: "All Saints' Day", holiday_type: S, source: P1006 },
    { holiday_date: '2026-11-02', name: "All Souls' Day", holiday_type: S, source: P1006 },
    // NCR-only: 49th ASEAN Summit and Related Summits (Proc. 1447). Applies to Metro Manila; MIS may deactivate for a campus outside NCR.
    { holiday_date: '2026-11-16', name: '49th ASEAN Summit (NCR special non-working day)', holiday_type: S, source: P1447 },
    { holiday_date: '2026-11-17', name: '49th ASEAN Summit (NCR special non-working day)', holiday_type: S, source: P1447 },
    { holiday_date: '2026-11-18', name: '49th ASEAN Summit (NCR special non-working day)', holiday_type: S, source: P1447 },
    { holiday_date: '2026-11-30', name: 'Bonifacio Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-12-08', name: 'Feast of the Immaculate Conception of Mary', holiday_type: S, source: P1006 },
    { holiday_date: '2026-12-24', name: 'Christmas Eve', holiday_type: S, source: P1006 },
    { holiday_date: '2026-12-25', name: 'Christmas Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-12-30', name: 'Rizal Day', holiday_type: R, source: P1006 },
    { holiday_date: '2026-12-31', name: 'Last Day of the Year', holiday_type: S, source: P1006 }
  ].map(entry => Object.freeze({ ...entry, is_verified: 1 }))),
  // 2027: Proclamation No. 1427 (Sept 8, 2026). Eid'l Fitr / Eid'l Adha 2027 are NOT listed: they are proclaimed later
  // (NCMF recommendation) and must be added by MIS once published. They are deliberately not guessed here.
  2027: Object.freeze([
    { holiday_date: '2027-01-01', name: "New Year's Day", holiday_type: R },
    { holiday_date: '2027-02-06', name: 'Chinese New Year', holiday_type: S },
    { holiday_date: '2027-02-25', name: 'EDSA People Power Revolution Anniversary', holiday_type: W },
    { holiday_date: '2027-03-25', name: 'Maundy Thursday', holiday_type: R },
    { holiday_date: '2027-03-26', name: 'Good Friday', holiday_type: R },
    { holiday_date: '2027-03-27', name: 'Black Saturday', holiday_type: S },
    { holiday_date: '2027-04-09', name: 'Araw ng Kagitingan', holiday_type: R },
    { holiday_date: '2027-05-01', name: 'Labor Day', holiday_type: R },
    { holiday_date: '2027-06-12', name: 'Independence Day', holiday_type: R },
    { holiday_date: '2027-08-21', name: 'Ninoy Aquino Day', holiday_type: S },
    { holiday_date: '2027-08-30', name: 'National Heroes Day', holiday_type: R },
    { holiday_date: '2027-11-01', name: "All Saints' Day", holiday_type: S },
    { holiday_date: '2027-11-02', name: "All Souls' Day", holiday_type: S },
    { holiday_date: '2027-11-30', name: 'Bonifacio Day', holiday_type: R },
    { holiday_date: '2027-12-08', name: 'Feast of the Immaculate Conception of Mary', holiday_type: S },
    { holiday_date: '2027-12-24', name: 'Christmas Eve', holiday_type: S },
    { holiday_date: '2027-12-25', name: 'Christmas Day', holiday_type: R },
    { holiday_date: '2027-12-30', name: 'Rizal Day', holiday_type: R },
    { holiday_date: '2027-12-31', name: 'Last Day of the Year', holiday_type: S }
  ].map(entry => Object.freeze({ ...entry, source: P1427, is_verified: 1 })))
})

const DEFAULT_SOURCE = 'Fixed-date default (RA 9492 / customary yearly proclamation). Not yet confirmed against the proclamation for this year.'

function pad(value) { return String(value).padStart(2, '0') }
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
function isSundayDateString(value) { return isValidDateString(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 0 }
function manilaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
function lastMondayOfAugust(year) {
  for (let day = 31; day >= 1; day -= 1) if (new Date(Date.UTC(year, 7, day)).getUTCDay() === 1) return `${year}-08-${pad(day)}`
  return `${year}-08-25`
}

// Dates fixed by law/custom every year. Movable observances (Holy Week, Chinese New Year, Eid'l Fitr, Eid'l Adha)
// are proclaimed each year, so they are NOT guessed here; MIS adds them in the Holidays page.
function fixedDateDefaults(year) {
  const y = Number(year)
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return []
  const entry = (md, name, holiday_type) => ({ holiday_date: `${y}-${md}`, name, holiday_type, source: DEFAULT_SOURCE, is_verified: 0 })
  return [
    entry('01-01', "New Year's Day", R), entry('02-25', 'EDSA People Power Revolution Anniversary', W),
    entry('04-09', 'Araw ng Kagitingan', R), entry('05-01', 'Labor Day', R), entry('06-12', 'Independence Day', R),
    entry('08-21', 'Ninoy Aquino Day', S), { ...entry('08-01', 'National Heroes Day', R), holiday_date: lastMondayOfAugust(y) },
    entry('11-01', "All Saints' Day", S), entry('11-30', 'Bonifacio Day', R),
    entry('12-08', 'Feast of the Immaculate Conception of Mary', S), entry('12-25', 'Christmas Day', R),
    entry('12-30', 'Rizal Day', R), entry('12-31', 'Last Day of the Year', S)
  ].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))
}
// Baseline = verified list when we have it, otherwise the fixed-date defaults.
function verifiedYears() { return Object.keys(VERIFIED_HOLIDAYS).map(Number).sort((a, b) => a - b) }
function baselineForYear(year) {
  const y = Number(year)
  return (VERIFIED_HOLIDAYS[y] ? [...VERIFIED_HOLIDAYS[y]] : fixedDateDefaults(y)).map(entry => ({ ...entry }))
}
function baselineForDate(dateString) {
  if (!isValidDateString(dateString)) return null
  return baselineForYear(Number(dateString.slice(0, 4))).find(entry => entry.holiday_date === dateString) || null
}

function isBlockingType(type) { return BLOCKING_TYPES.includes(type) }
function holidayTypeLabel(type, customLabel) { if (type === 'OTHER' && customLabel) return String(customLabel); return HOLIDAY_TYPE_LABELS[type] || String(type || '') }

function validateHolidayInput(input = {}) {
  const holiday_date = String(input.holiday_date ?? '').trim()
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ')
  const holiday_type = String(input.holiday_type ?? '').trim()
  const source = String(input.source ?? '').trim()
  if (!isValidDateString(holiday_date)) return { error: 'Enter a valid holiday date.' }
  const year = Number(holiday_date.slice(0, 4))
  if (year < 2000 || year > 2100) return { error: 'Holiday year must be between 2000 and 2100.' }
  if (!name) return { error: 'Enter the holiday name.' }
  if (name.length > 150) return { error: 'Holiday name must be 150 characters or fewer.' }
  if (!Object.values(HOLIDAY_TYPES).includes(holiday_type)) return { error: 'Choose Regular Holiday, Special Non-Working Day, Special Working Day or Others.' }
  const custom_type_label = String(input.custom_type_label ?? '').trim().replace(/\s+/g, ' ')
  if (holiday_type === 'OTHER' && !custom_type_label) return { error: 'Enter the holiday type for Others.' }
  if (custom_type_label.length > 100) return { error: 'Holiday type must be 100 characters or fewer.' }
  if (source.length > 255) return { error: 'Source must be 255 characters or fewer.' }
  return { error: null, values: { holiday_date, name, holiday_type, source: source || null, is_verified: input.is_verified ? 1 : 0, custom_type_label: holiday_type === 'OTHER' ? custom_type_label : null } }
}

// Single decision point used by both the API and tests.
// `holiday` is the effective record for the date (DB row, else baseline) or null. Inactive records do not apply.
function evaluateReservableDate(dateString, holiday, { blockSunday = true } = {}) {
  if (!isValidDateString(dateString)) return { ok: false, code: 'INVALID_DATE', message: 'Please enter a valid reservation date.', holiday: null }
  const active = holiday && (holiday.is_active === undefined || Number(holiday.is_active) === 1) ? holiday : null
  if (active && isBlockingType(active.holiday_type)) {
    return { ok: false, code: 'HOLIDAY', holiday: active, message: `Reservations are not allowed on ${active.name} (${holidayTypeLabel(active.holiday_type, active.custom_type_label)}, ${dateString}). Please choose another date.` }
  }
  if (blockSunday && isSundayDateString(dateString)) return { ok: false, code: 'SUNDAY', holiday: active, message: 'Sunday reservations are not allowed. Please choose another date.' }
  return { ok: true, code: active ? 'SPECIAL_WORKING' : 'OPEN', holiday: active, message: '' }
}

module.exports = Object.freeze({
  TIMEZONE, HOLIDAY_TYPES, HOLIDAY_TYPE_LABELS, BLOCKING_TYPES, VERIFIED_HOLIDAYS, verifiedYears, DEFAULT_SOURCE,
  isValidDateString, isSundayDateString, manilaDateString, lastMondayOfAugust,
  fixedDateDefaults, baselineForYear, baselineForDate, isBlockingType, holidayTypeLabel,
  validateHolidayInput, evaluateReservableDate
})
