'use strict'
const holidays = require('../utils/philippineHolidays.js')
const { poolQuery } = require('../utils/holidayService.js')
const { logAudit } = require('../utils/auditLogger.js')

function getDb() { return require('../database/db.js') }
const SELECT_HOLIDAY = "SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, holiday_type, custom_type_label, source, is_verified, is_active FROM holidays"

function fail(response, context, error, message = 'Unable to process the holiday request.') {
  console.error(`${context}:`, error?.code || error?.message || error)
  return response.status(500).json({ message })
}
const toApi = row => ({ ...row, is_verified: Number(row.is_verified) === 1, is_active: Number(row.is_active) === 1, blocks_reservations: Number(row.is_active) === 1 && holidays.isBlockingType(row.holiday_type), type_label: holidays.holidayTypeLabel(row.holiday_type, row.custom_type_label) })

// Existing PENDING/APPROVED reservations on a date that is now closed are FLAGGED, never deleted or auto-cancelled.
async function flagReservationsForDate(query, dateString, holiday) {
  const note = `${holiday.name} (${holidays.holidayTypeLabel(holiday.holiday_type, holiday.custom_type_label)}) - date is now closed. Review, reschedule or cancel.`.slice(0, 255)
  const result = await query("UPDATE reservations SET holiday_flag = 1, holiday_flag_note = ?, holiday_flagged_at = NOW() WHERE reservation_date = ? AND status IN ('PENDING','APPROVED')", [note, dateString])
  return Number(result?.affectedRows || 0)
}
async function unflagReservationsForDate(query, dateString) {
  const result = await query('UPDATE reservations SET holiday_flag = 0, holiday_flag_note = NULL, holiday_flagged_at = NULL WHERE reservation_date = ? AND holiday_flag = 1', [dateString])
  return Number(result?.affectedRows || 0)
}
// Re-evaluate one date after any holiday change: flag when closed, clear flags when open again.
async function syncFlagsForDate(query, dateString) {
  const rows = await query(`${SELECT_HOLIDAY} WHERE holiday_date = ? LIMIT 1`, [dateString])
  const holiday = rows[0]
  if (holiday && Number(holiday.is_active) === 1 && holidays.isBlockingType(holiday.holiday_type)) return { flagged: await flagReservationsForDate(query, dateString, holiday), cleared: 0 }
  return { flagged: 0, cleared: await unflagReservationsForDate(query, dateString) }
}

// Copy the built-in baseline for a year into the table. INSERT IGNORE never overwrites MIS edits and never
// resurrects a removed date (removal is a soft delete, so its row still exists).
async function materializeYear(query, year, createdBy = null) {
  let inserted = 0
  for (const entry of holidays.baselineForYear(year)) {
    const result = await query('INSERT IGNORE INTO holidays (holiday_date, name, holiday_type, source, is_verified, is_active, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)', [entry.holiday_date, entry.name, entry.holiday_type, entry.source, entry.is_verified ? 1 : 0, createdBy])
    const added = Number(result?.affectedRows || 0)
    inserted += added
    // A newly materialised closed date must flag bookings that already exist on it (transparent, never deleted).
    if (added && entry.holiday_type !== holidays.HOLIDAY_TYPES.SPECIAL_WORKING) await flagReservationsForDate(query, entry.holiday_date, entry)
  }
  return inserted
}

// GET /api/holidays?year=2026  (all signed-in roles: calendars need the names)
async function listHolidays(request, response) {
  const query = poolQuery(getDb())
  const nowYear = Number(holidays.manilaDateString().slice(0, 4))
  const year = request.query?.year === undefined ? nowYear : Number(request.query.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return response.status(400).json({ message: 'Enter a valid year between 2000 and 2100.' })
  try {
    // Lazy seeding so the table always shows the baseline for the requested year.
    try { await materializeYear(query, year, null) } catch (error) { console.warn('Holiday baseline not materialised:', error.code || error.message) }
    const rows = await query(`${SELECT_HOLIDAY} WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date ASC`, [`${year}-01-01`, `${year}-12-31`])
    return response.json({ year, timezone: holidays.TIMEZONE, holidays: rows.map(toApi) })
  } catch (error) {
    // Table unavailable: serve the built-in baseline so calendars still show closed dates.
    console.warn('Holiday list fell back to baseline:', error.code || error.message)
    return response.json({ year, timezone: holidays.TIMEZONE, fallback: true, holidays: holidays.baselineForYear(year).map((entry, index) => toApi({ id: null, ...entry, is_active: 1 })) })
  }
}

// POST /api/holidays  (MIS Super Admin)
async function createHoliday(request, response) {
  const validation = holidays.validateHolidayInput(request.body)
  if (validation.error) return response.status(400).json({ message: validation.error })
  const v = validation.values
  const query = poolQuery(getDb())
  try {
    const existing = await query('SELECT id, is_active FROM holidays WHERE holiday_date = ? LIMIT 1', [v.holiday_date])
    if (existing.length && Number(existing[0].is_active) === 1) return response.status(409).json({ message: 'A holiday already exists on that date. Edit it instead.' })
    if (existing.length) await query('UPDATE holidays SET name=?, holiday_type=?, custom_type_label=?, source=?, is_verified=?, is_active=1, updated_by=? WHERE id=?', [v.name, v.holiday_type, v.custom_type_label, v.source, v.is_verified, request.user.id, existing[0].id])
    else await query('INSERT INTO holidays (holiday_date, name, holiday_type, custom_type_label, source, is_verified, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', [v.holiday_date, v.name, v.holiday_type, v.custom_type_label, v.source, v.is_verified, request.user.id])
    const sync = await syncFlagsForDate(query, v.holiday_date)
    logAudit(request.user.id, 'HOLIDAY ADDED', `${v.name} (${holidays.holidayTypeLabel(v.holiday_type, v.custom_type_label)}) on ${v.holiday_date}; ${sync.flagged} existing reservation(s) flagged`)
    const rows = await query(`${SELECT_HOLIDAY} WHERE holiday_date = ? LIMIT 1`, [v.holiday_date])
    return response.status(201).json({ message: `Holiday saved.${sync.flagged ? ` ${sync.flagged} existing reservation(s) on this date were flagged for review (not deleted).` : ''}`, holiday: toApi(rows[0]), flagged_reservations: sync.flagged })
  } catch (error) { return fail(response, 'Unable to create holiday', error, 'Unable to save the holiday.') }
}

// PUT /api/holidays/:id  (MIS Super Admin)
async function updateHoliday(request, response) {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid holiday ID.' })
  const validation = holidays.validateHolidayInput(request.body)
  if (validation.error) return response.status(400).json({ message: validation.error })
  const v = validation.values
  const query = poolQuery(getDb())
  try {
    const current = await query('SELECT id, DATE_FORMAT(holiday_date, \'%Y-%m-%d\') AS holiday_date FROM holidays WHERE id = ? LIMIT 1', [id])
    if (!current.length) return response.status(404).json({ message: 'Holiday not found.' })
    const clash = await query('SELECT id FROM holidays WHERE holiday_date = ? AND id <> ? LIMIT 1', [v.holiday_date, id])
    if (clash.length) return response.status(409).json({ message: 'Another holiday record already uses that date.' })
    await query('UPDATE holidays SET holiday_date=?, name=?, holiday_type=?, custom_type_label=?, source=?, is_verified=?, is_active=1, updated_by=? WHERE id=?', [v.holiday_date, v.name, v.holiday_type, v.custom_type_label, v.source, v.is_verified, request.user.id, id])
    const oldDate = current[0].holiday_date
    let flagged = 0, cleared = 0
    const newSync = await syncFlagsForDate(query, v.holiday_date); flagged += newSync.flagged; cleared += newSync.cleared
    if (oldDate !== v.holiday_date) { const oldSync = await syncFlagsForDate(query, oldDate); cleared += oldSync.cleared }
    logAudit(request.user.id, 'HOLIDAY UPDATED', `${v.name} on ${v.holiday_date} (${holidays.holidayTypeLabel(v.holiday_type, v.custom_type_label)}); ${flagged} reservation(s) flagged, ${cleared} flag(s) cleared`)
    const rows = await query(`${SELECT_HOLIDAY} WHERE id = ? LIMIT 1`, [id])
    return response.json({ message: `Holiday updated.${flagged ? ` ${flagged} existing reservation(s) on this date were flagged for review (not deleted).` : ''}`, holiday: toApi(rows[0]), flagged_reservations: flagged, cleared_flags: cleared })
  } catch (error) { return fail(response, 'Unable to update holiday', error, 'Unable to update the holiday.') }
}

// DELETE /api/holidays/:id  (MIS Super Admin) - soft delete so a removed baseline date is not re-seeded.
async function removeHoliday(request, response) {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid holiday ID.' })
  const query = poolQuery(getDb())
  try {
    const rows = await query(`${SELECT_HOLIDAY} WHERE id = ? LIMIT 1`, [id])
    if (!rows.length) return response.status(404).json({ message: 'Holiday not found.' })
    if (Number(rows[0].is_active) !== 1) return response.status(409).json({ message: 'This holiday is already removed. Restore it from the Recycle Bin.' })
    await query('UPDATE holidays SET is_active = 0, updated_by = ? WHERE id = ?', [request.user.id, id])
    // Removed holidays are listed in the Recycle Bin (type "Holiday"); restoring re-activates the same row.
    const snapshot = { ...rows[0], is_active: 0 }
    await query('INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES (?, ?, ?, ?, ?)', ['holidays', id, `${rows[0].name} (${rows[0].holiday_date})`.slice(0, 255), JSON.stringify(snapshot), request.user.id])
    const sync = await syncFlagsForDate(query, rows[0].holiday_date)
    logAudit(request.user.id, 'HOLIDAY REMOVED', `${rows[0].name} on ${rows[0].holiday_date} removed; ${sync.cleared} reservation flag(s) cleared`)
    return response.json({ message: 'Holiday removed and moved to the Recycle Bin. The date is bookable again (Sundays stay blocked).', cleared_flags: sync.cleared, recycle_item: true })
  } catch (error) { return fail(response, 'Unable to remove holiday', error, 'Unable to remove the holiday.') }
}

// POST /api/holidays/generate-defaults {year}  (MIS Super Admin) - adds fixed-date defaults for a future year.
async function generateDefaults(request, response) {
  const year = Number(request.body?.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return response.status(400).json({ message: 'Enter a valid year between 2000 and 2100.' })
  const query = poolQuery(getDb())
  try {
    const inserted = await materializeYear(query, year, request.user.id)
    let flagged = 0
    for (const entry of holidays.baselineForYear(year)) flagged += (await syncFlagsForDate(query, entry.holiday_date)).flagged
    logAudit(request.user.id, 'HOLIDAY DEFAULTS GENERATED', `Year ${year}: ${inserted} date(s) added; ${flagged} reservation(s) flagged`)
    return response.json({ message: `${inserted} fixed-date default(s) added for ${year}. Defaults are marked Unverified; add movable holidays (Holy Week, Eid'l Fitr/Adha, Chinese New Year) from the official proclamations.`, inserted, flagged_reservations: flagged })
  } catch (error) { return fail(response, 'Unable to generate holiday defaults', error, 'Unable to generate holiday defaults.') }
}

module.exports = { listHolidays, createHoliday, updateHoliday, removeHoliday, generateDefaults, materializeYear, syncFlagsForDate }
