'use strict'
const VALID_ROLES = new Set(['MIS', 'Dean', 'Teacher', 'Inventory Staff'])
function validDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
function validateLaboratoryFilter(raw) {
  if (raw == null || String(raw).trim() === '') return { error: null, id: null }
  const value = String(raw).trim()
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) return { error: 'Laboratory filter must be a positive laboratory ID.', id: null }
  return { error: null, id: Number(value) }
}
function validateAuditReportFilters(query = {}) {
  const role = String(query.role || '').trim()
  const rawUserId = String(query.user_id ?? '').trim()
  const from = String(query.from || '').trim()
  const to = String(query.to || '').trim()
  if (role && !VALID_ROLES.has(role)) return { error: 'Invalid role filter.' }
  if (rawUserId && (!/^\d+$/.test(rawUserId) || !Number.isSafeInteger(Number(rawUserId)))) return { error: 'User ID filter must be a non-negative whole number.' }
  if ((from && !validDateString(from)) || (to && !validDateString(to))) return { error: 'Use valid dates in YYYY-MM-DD format.' }
  if (from && to && from > to) return { error: 'The start date must be on or before the end date.' }
  return { error: null, filters: { role, userId: rawUserId === '' ? null : Number(rawUserId), from: from || null, to: to || null } }
}
module.exports = { VALID_ROLES, validDateString, validateLaboratoryFilter, validateAuditReportFilters }
