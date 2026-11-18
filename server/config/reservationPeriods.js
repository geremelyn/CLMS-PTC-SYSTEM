'use strict'
// Confirmed PTC laboratory reservation periods (half-day booking).
const RESERVATION_PERIODS = Object.freeze({
  MORNING: Object.freeze({ key: 'MORNING', label: 'Morning', start: '08:00:00', end: '12:00:00', display: '8:00 AM – 12:00 PM' }),
  AFTERNOON: Object.freeze({ key: 'AFTERNOON', label: 'Afternoon', start: '12:00:00', end: '17:00:00', display: '12:00 PM – 5:00 PM' })
})
const PERIOD_KEYS = Object.freeze(Object.keys(RESERVATION_PERIODS))

function resolvePeriod(value) {
  if (typeof value !== 'string') return null
  return RESERVATION_PERIODS[value.trim().toUpperCase()] || null
}
const hhmm = value => String(value || '').slice(0, 5)
// Half-open overlap, identical to the SQL predicate "start_time < periodEnd AND end_time > periodStart".
function overlapsPeriod(reservation, period) {
  return hhmm(reservation.start_time) < hhmm(period.end) && hhmm(reservation.end_time) > hhmm(period.start)
}
// Pure availability calculation (also used by tests). `blocking` = reservations that currently occupy the lab/date.
function computePeriodAvailability({ blocking = [], labFrom, labUntil, date, today, nowMinutes, closedReason = null }) {
  return PERIOD_KEYS.map(key => {
    const p = RESERVATION_PERIODS[key]
    let reason = null
    if (closedReason) reason = closedReason
    else if (hhmm(p.start) < hhmm(labFrom) || hhmm(p.end) > hhmm(labUntil)) reason = 'OUTSIDE_LAB_HOURS'
    else if (date === today && Number(hhmm(p.start).slice(0, 2)) * 60 + Number(hhmm(p.start).slice(3, 5)) <= nowMinutes) reason = 'ALREADY_STARTED'
    else if (blocking.some(r => overlapsPeriod(r, p))) reason = 'OCCUPIED'
    return { period: key, label: p.label, start_time: p.start, end_time: p.end, display: p.display, available: reason === null, reason }
  })
}
module.exports = { RESERVATION_PERIODS, PERIOD_KEYS, resolvePeriod, overlapsPeriod, computePeriodAvailability }
