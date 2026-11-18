'use strict'
const { positiveInteger, requiredText } = require('./recordValidation.js')
const VALID_STATUSES = new Set(['OPEN', 'USED', 'UNAVAILABLE'])
// CP174: dates must be real calendar dates written YYYY-MM-DD (no times, no padding). Empty/null means "not provided".
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
function normalizeTime(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(text)) return undefined
  return text.length === 5 ? `${text}:00` : text
}
// options.requireOthersReason (default true): the add/edit form and API require a reason for Others. Excel import passes false
// so existing spreadsheets that carry a custom status without a Reason column keep importing exactly as before.
function validateLaboratoryInput(input = {}, { requireOthersReason = true } = {}) {
  const name = String(input.laboratory_name ?? '').trim()
  const capacity = positiveInteger(input.capacity)
  const rawStatus = String(input.status ?? '').trim().toUpperCase()
  const isOther = rawStatus === 'OTHERS'
  const statusOther = isOther ? String(input.status_other ?? '').trim() : null
  // "Others" is stored as UNAVAILABLE (ENUM unchanged, lab stays non-reservable) with the custom label in status_other.
  const status = isOther ? 'UNAVAILABLE' : rawStatus
  const interval = positiveInteger(input.booking_interval == null || input.booking_interval === '' ? 60 : input.booking_interval)
  if (!requiredText(name)) return { error: 'Laboratory name is required.' }
  if (name.length > 100) return { error: 'Laboratory name must be 100 characters or fewer.'}
  if (!capacity) return { error: 'Capacity must be a positive whole number.' }
  if (isOther && !statusOther) return { error: 'Enter the custom laboratory status for Others.' }
  if (isOther && statusOther.length > 100) return { error: 'Custom status must be 100 characters or fewer.' }
  if (!VALID_STATUSES.has(status)) return { error: 'Choose a valid laboratory status.' }
  if (!interval) return { error: 'Booking interval must be a positive whole number of minutes.' }
  const from = normalizeTime(input.available_from)
  const until = normalizeTime(input.available_until)
  if ((input.available_from || input.available_until) && (!from || !until)) return { error: 'Provide both valid opening and closing times in HH:MM or HH:MM:SS format.' }
  if (from === undefined || until === undefined) return { error: 'Opening and closing times must be valid 24-hour times.' }
  if (from && until && from >= until) return { error: 'Available until must be later than available from.' }
  const range = status === 'OPEN' ? [input.available_date_from, input.available_date_until] : status === 'UNAVAILABLE' ? [input.unavailable_from, input.unavailable_until] : [input.used_from, input.used_until]
  if (range.some(value => value != null && value !== '' && !isValidDateOnly(value))) return { error: 'Enter valid dates in YYYY-MM-DD format (for example 2026-11-30).' }
  if (range[0] && range[1] && String(range[0]) > String(range[1])) return { error: 'The ending date must be on or after the starting date.' }
  // Unavailable AND Others (stored as UNAVAILABLE) both require a reason; it is saved in laboratories.reason.
  const reason = String(input.reason ?? '').trim()
  if (status === 'UNAVAILABLE' && !requiredText(reason) && (!isOther || requireOthersReason)) return { error: isOther ? 'Enter the reason for the Others status.' : 'A reason is required when a laboratory is unavailable.' }
  if (reason.length > 255) return { error: 'Reason must be 255 characters or fewer.' }
  return { error: null, values: { laboratory_name: name, capacity, status, status_other: statusOther, reason: status === 'UNAVAILABLE' ? reason : null, booking_interval: interval, available_from: from, available_until: until } }
}
module.exports = { validateLaboratoryInput, normalizeTime, isValidDateOnly }
