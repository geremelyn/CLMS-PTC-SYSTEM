// Single source of truth for "where does this role land after sign-in / required password change".
// Fixed roles map to their own dashboard. The fixed `User` role (and an account with no role value) uses the Teacher
// dashboard. A custom role ("Others") has no dashboard of its own and no extra permissions (see AppLayout ROUTE_ACCESS),
// so it falls back to Change Password, the only page it may open. To give a specific custom role its own landing page
// later, add its label to CUSTOM_ROLE_DASHBOARDS (keyed by the lower-cased role_other text); nothing else needs to change.
export const ROLE_DASHBOARDS = {
  MIS: '/mis-dashboard',
  Dean: '/dean-dashboard',
  'Inventory Staff': '/inventory-dashboard',
  Teacher: '/teacher-dashboard',
  User: '/teacher-dashboard',
}
export const CUSTOM_ROLE_DASHBOARDS = {}
// CP68: every custom role uses the Teacher dashboard (lab reservation features only; see AppLayout ROUTE_ACCESS).
export const CUSTOM_ROLE_FALLBACK = '/teacher-dashboard'

export function getDefaultDashboard(role, roleOther) {
  const key = role || 'User'
  if (ROLE_DASHBOARDS[key]) return ROLE_DASHBOARDS[key]
  const custom = String(roleOther || '').trim().toLowerCase()
  return (custom && CUSTOM_ROLE_DASHBOARDS[custom]) || CUSTOM_ROLE_FALLBACK
}
