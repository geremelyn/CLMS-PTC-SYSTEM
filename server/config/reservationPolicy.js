'use strict'
// CP178 A1: the fallback laboratory hours (used when a laboratory has no opening/closing time of its own) follow the system operating hours
// (config/reservationTime.js, 07:00-21:00) instead of a separate hard-coded 08:00-17:00. CLMS_FALLBACK_LAB_OPEN / CLMS_FALLBACK_LAB_CLOSE still override.
const OPERATING = require('./reservationTime.js')
const DEFAULT_OPEN = `${OPERATING.OPEN}:00`, DEFAULT_CLOSE = `${OPERATING.CLOSE}:00`
function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim())) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
function timeFromEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return fallback
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) return fallback
  return raw.length === 5 ? `${raw}:00` : raw
}
const approvalCutoffDays = positiveIntegerFromEnv('CLMS_RESERVATION_CUTOFF_DAYS', 3)
const fallbackLabOpeningTime = timeFromEnv('CLMS_FALLBACK_LAB_OPEN', DEFAULT_OPEN)
const fallbackLabClosingTime = timeFromEnv('CLMS_FALLBACK_LAB_CLOSE', DEFAULT_CLOSE)
const defaultBookingInterval = positiveIntegerFromEnv('CLMS_DEFAULT_BOOKING_INTERVAL', 60)
const sundaySetting = String(process.env.CLMS_BLOCK_SUNDAY ?? 'true').trim().toLowerCase()
const blockSunday = ['1', 'true', 'yes', 'on'].includes(sundaySetting)
const allowedConflictStatuses = new Set(['PENDING', 'APPROVED', 'DECLINED', 'CANCELLED', 'COMPLETED'])
const requestedConflictStatuses = String(process.env.CLMS_CONFLICT_STATUSES || 'PENDING,APPROVED').split(',').map(value => value.trim().toUpperCase()).filter(value => allowedConflictStatuses.has(value))
const conflictStatuses = [...new Set(requestedConflictStatuses.length ? requestedConflictStatuses : ['PENDING', 'APPROVED'])]
const safeHours = fallbackLabOpeningTime < fallbackLabClosingTime
module.exports = Object.freeze({
  approvalCutoffDays,
  fallbackLabOpeningTime: safeHours ? fallbackLabOpeningTime : DEFAULT_OPEN,
  fallbackLabClosingTime: safeHours ? fallbackLabClosingTime : DEFAULT_CLOSE,
  defaultBookingInterval,
  conflictStatuses,
  conflictStatusSql: conflictStatuses.map(value => `'${value}'`).join(','),
  blockSunday,
  confirmationStatus: 'UNCONFIRMED — verify with Sir JC before production'
})
