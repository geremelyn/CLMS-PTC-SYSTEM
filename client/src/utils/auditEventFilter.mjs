// CP108: Audit Log Event Type filter. Pure helpers (no DOM, no HTTP).
// Event types are NOT hardcoded: they are the distinct `action` values present in the audit records
// (the server writes some dynamically, e.g. "RESERVATION APPROVED", "COMPUTERS IMPORT").
export const ALL_EVENTS = ''

// CP120/CP144: event types the server always writes under a fixed name (each one is a literal action passed to logAudit() in server/controllers,
// or - MAINTENANCE DELETE - the recycle-bin `${type} DELETE` pattern; a server test checks every entry against the server source, so none is invented).
// The dropdown offers them even before the first such record exists. Event types the server builds dynamically (e.g. "RESERVATION APPROVED",
// "COMPUTERS IMPORT") come from the data. Selecting a type with no records shows an empty list.
export const KNOWN_AUDIT_EVENTS = Object.freeze([
  'ACCOUNT CREATION',
  'ACCOUNT MODIFICATION',
  'ASSET ASSIGNMENT / UPDATE',
  'BULK ASSET IMPORT',
  'CUSTOM ROLE DELETED',
  'HOLIDAY ADDED',
  'HOLIDAY DEFAULTS GENERATED',
  'HOLIDAY REMOVED',
  'HOLIDAY UPDATED',
  'LOOKUP OPTION CREATED',
  'LOOKUP OPTION DELETED',
  'MAINTENANCE DELETE',
  'MAINTENANCE UPDATE',
  'MAINTENANCE UPDATE UNDONE',
  'RECYCLE BIN PERMANENT DELETE',
  'RECYCLE BIN RESTORE',
  'RESERVATION AUTO-CANCELLED',
  'RESERVATION CANCELLATION',
  'RESERVATION CANCELLATION UNDONE',
  'RESERVATION CREATION',
  'RESERVATION CREATION UNDONE',
  'RESERVATION DECISION UNDONE',
  'RESERVATION DELETE',
  'TEACHER SCHEDULE DELETE',
  'TEACHER SCHEDULE UPLOAD',
  'UPDATE UNDONE',
  'USER LOGIN',
  'USER LOGOUT',
  'WORKSTATION ASSIGNMENT',
])

export function auditEventTypes(logs = [], known = []) {
  const seen = new Set(known.map(a => String(a ?? '').trim()).filter(Boolean))
  for (const log of logs) { const a = String(log?.action ?? '').trim(); if (a) seen.add(a) }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

// Same search fields as before CP108; the event type is an exact match on `action` and combines with the search (AND).
export function filterAuditLogs(logs = [], { eventType = ALL_EVENTS, search = '', roleLabel = log => log.role || '—' } = {}) {
  const term = String(search).trim().toLowerCase()
  return logs.filter(log => {
    if (eventType !== ALL_EVENTS && String(log.action ?? '').trim() !== eventType) return false
    return [log.action, log.description, log.created_at, log.full_name || 'System', log.username, roleLabel(log)].some(value => String(value ?? '').toLowerCase().includes(term))
  })
}
