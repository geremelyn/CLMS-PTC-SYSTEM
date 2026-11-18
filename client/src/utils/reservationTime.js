// Frontend helpers for the Reserve Laboratory time pickers. These only BUILD the choices (07:00-21:00, 30-minute steps,
// matching the CP23 backend defaults in server/config/reservationTime.js). The server remains the authority: it
// re-validates every request and its message is shown to the user.
export const RESERVATION_OPEN = '07:00'
export const RESERVATION_CLOSE = '21:00'
export const RESERVATION_STEP_MINUTES = 30
// CP60: Morning / Afternoon choose which part of the day the Start/End lists show. Morning = AM times (7:00 AM - 12:00 PM,
// where 12:00 PM is only an END point); Afternoon = PM times (12:00 PM - 9:00 PM). Overall hours stay 7:00 AM - 9:00 PM.
export const PERIOD_PRESETS = Object.freeze({
  MORNING: { label: 'Morning', start: '07:00', end: '12:00' },
  AFTERNOON: { label: 'Afternoon', start: '12:00', end: '21:00' }
})
const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const pad = number => String(number).padStart(2, '0')
export function formatTimeLabel(value) {
  if (!value) return ''
  const hour = Number(value.slice(0, 2))
  return `${hour % 12 || 12}:${value.slice(3, 5)} ${hour >= 12 ? 'PM' : 'AM'}`
}
export function buildTimeOptions(open = RESERVATION_OPEN, close = RESERVATION_CLOSE, step = RESERVATION_STEP_MINUTES) {
  const options = []
  for (let minutes = toMinutes(open); minutes <= toMinutes(close); minutes += step) options.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`)
  return options
}
export const TIME_OPTIONS = buildTimeOptions()
export const START_OPTIONS = TIME_OPTIONS.slice(0, -1)
export const endOptionsFor = start => TIME_OPTIONS.filter(option => !start || option > start)
// CP60: option lists limited to the chosen day part. Start can be any step before the part's end; End must be after Start.
export function startOptionsForPeriod(period) {
  const range = PERIOD_PRESETS[period] || { start: RESERVATION_OPEN, end: RESERVATION_CLOSE }
  return TIME_OPTIONS.filter(option => option >= range.start && option < range.end)
}
export function endOptionsForPeriod(period, start) {
  const range = PERIOD_PRESETS[period] || { start: RESERVATION_OPEN, end: RESERVATION_CLOSE }
  return TIME_OPTIONS.filter(option => option > range.start && option <= range.end && (!start || option > start))
}
// Hard closures returned by GET /reservations/availability for every period (not "some of the morning is taken").
const HARD_CLOSED = new Set(['LAB_NOT_OPEN', 'PAST_DATE', 'SUNDAY', 'HOLIDAY'])
export function isDateClosed(availability) {
  const periods = availability?.periods || []
  return periods.length > 0 && periods.every(item => HARD_CLOSED.has(item.reason))
}
// Plain-language note about partially booked day parts; informational only (never blocks the form).
export function busyNote(availability) {
  const busy = (availability?.periods || []).filter(item => item.reason === 'OCCUPIED').map(item => item.label.toLowerCase())
  return busy.length ? `Part of the ${busy.join(' and ')} is already reserved. Pick times that do not overlap an existing reservation.` : ''
}
// The professor name comes from the logged-in account. full_name is the stored display name; when it is blank but the
// account has its separate surname + first name (and optional middle initial), the name is composed from those saved
// parts in the same format the server uses ("First M. Surname"). Nothing is invented: with neither, the name stays empty
// and the form still refuses to submit.
export function describeProfessor(user) {
  const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ')
  const surname = clean(user?.surname), first = clean(user?.first_name), initial = clean(user?.middle_initial).replace(/\./g, '').toUpperCase()
  const composed = surname && first ? `${first}${initial ? ` ${initial}.` : ''} ${surname}` : ''
  return { name: clean(user?.full_name) || composed, role: String(user?.role || '').trim() }
}

// Date Requested: when the request was SUBMITTED (reservations.created_at), not the reservation date. Shown in Asia/Manila.
// The API sends created_at as an ISO instant; a zone-less "YYYY-MM-DD HH:MM:SS" value is the server's +08:00 wall time.
export function formatDateRequested(createdAt) {
  if (!createdAt) return '—'
  const raw = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt).trim()
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}+08:00` : raw
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date)
}
