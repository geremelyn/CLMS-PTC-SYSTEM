export function reservationTimestamp(item) {
  const value = item?.created_at
    ? new Date(item.created_at).getTime()
    : new Date(`${item?.reservation_date || ''}T${item?.start_time || '00:00'}`).getTime()
  return Number.isFinite(value) ? value : 0
}

export function sortReservationsNewestFirst(reservations = []) {
  return [...reservations].sort((a, b) => {
    const byTimestamp = reservationTimestamp(b) - reservationTimestamp(a)
    return byTimestamp || Number(b?.id || 0) - Number(a?.id || 0)
  })
}

// ---- CP26: My Reservations (Dean / Teacher) ----
// A "failed submission" is a request the system rejected at creation time (inside the scheduling cutoff or overlapping
// an existing booking): it is stored as DECLINED with a system note, no MIS decision (decided_by/decided_at empty).
// It never entered the approval flow, so it must not appear as a reservation. A reservation MIS actually declined,
// or one declined later by the scheduling-cutoff sweep (decided_at set), is a real reservation and stays visible.
const FAILED_SUBMISSION_NOTE_PREFIXES = ['Reservation requests must be submitted more than', 'The requested time overlaps']
export function isFailedSubmission(item) {
  if (String(item?.status || '').toUpperCase() !== 'DECLINED') return false
  if (item?.decided_by != null || item?.decided_at) return false
  const note = String(item?.decision_note || '')
  return FAILED_SUBMISSION_NOTE_PREFIXES.some(prefix => note.startsWith(prefix)) || (/^The .* session already has a reservation/.test(note))
}

export function isAutoCancelled(item) {
  return String(item?.status || '').toUpperCase() === 'CANCELLED' && String(item?.cancellation_note || '').startsWith('Automatically cancelled:')
}

// "Undo creation" is only meaningful for a request still waiting for a decision.
export function canUndoReservationCreation(item) {
  if (String(item?.status || '').toUpperCase() !== 'PENDING') return false
  if (isFailedSubmission(item) || item?.decided_by != null || item?.decided_at || item?.cancelled_at) return false
  return Number.isFinite(new Date(String(item?.created_at || '').replace(' ', 'T')).getTime())
}

export function visibleOwnReservations(reservations = []) {
  return reservations.filter(item => !isFailedSubmission(item))
}

// Newest submission first; COMPLETED reservations are moved to the bottom (each group keeps newest-first order).
export function sortMyReservations(reservations = []) {
  const isCompleted = item => String(item?.status || '').toUpperCase() === 'COMPLETED'
  const sorted = sortReservationsNewestFirst(reservations)
  return [...sorted.filter(item => !isCompleted(item)), ...sorted.filter(isCompleted)]
}
