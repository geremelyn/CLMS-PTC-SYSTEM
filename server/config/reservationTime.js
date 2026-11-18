'use strict'
// Single source of truth for reservation time rules (backend). Change here or via env; do not hardcode elsewhere.
//   CLMS_RESERVATION_OPEN   default 07:00   laboratory operating hours start
//   CLMS_RESERVATION_CLOSE  default 21:00   laboratory operating hours end
//   CLMS_RESERVATION_STEP_MINUTES default 30  start/end time increment
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/
function hhmmFromEnv(name, fallback) { const raw = String(process.env[name] || '').trim(); return HHMM.test(raw) ? raw.slice(0, 5) : fallback }
function stepFromEnv() { const raw = String(process.env.CLMS_RESERVATION_STEP_MINUTES || '').trim(); const n = /^\d+$/.test(raw) ? Number(raw) : 30; return n > 0 && n <= 240 ? n : 30 }
let OPEN = hhmmFromEnv('CLMS_RESERVATION_OPEN', '07:00')
let CLOSE = hhmmFromEnv('CLMS_RESERVATION_CLOSE', '21:00')
if (OPEN >= CLOSE) { OPEN = '07:00'; CLOSE = '21:00' }
const STEP_MINUTES = stepFromEnv()
const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const pad = n => String(n).padStart(2, '0')
const fromMinutes = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
function display(t) { const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}` }
const OPERATING_DISPLAY = `${display(OPEN)} – ${display(CLOSE)}`

// Returns { ok, start, end (HH:MM:SS), message }. Backend rule check: format, 30-min increments, end > start, inside operating hours.
function validateTimeRange(startTime, endTime) {
  const bad = message => ({ ok: false, message })
  if (typeof startTime !== 'string' || typeof endTime !== 'string' || !HHMM.test(startTime.trim()) || !HHMM.test(endTime.trim())) return bad('Please enter valid start and end times.')
  const start = startTime.trim().slice(0, 5), end = endTime.trim().slice(0, 5)
  if (toMinutes(start) % STEP_MINUTES !== 0 || toMinutes(end) % STEP_MINUTES !== 0) return bad(`Start and end times must be in ${STEP_MINUTES}-minute increments.`)
  if (start >= end) return bad('End time must be later than the start time.')
  if (start < OPEN || end > CLOSE) return bad(`Reservations must be within laboratory operating hours (${OPERATING_DISPLAY}).`)
  return { ok: true, start: `${start}:00`, end: `${end}:00`, message: '' }
}
// Allowed selectable times for UIs / API consumers.
function timeOptions() { const out = []; for (let m = toMinutes(OPEN); m <= toMinutes(CLOSE); m += STEP_MINUTES) out.push(fromMinutes(m)); return out }
module.exports = Object.freeze({ OPEN, CLOSE, STEP_MINUTES, OPERATING_DISPLAY, validateTimeRange, timeOptions, display })
