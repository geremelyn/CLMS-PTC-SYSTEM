// Single source of truth for which File Actions each page shows to which role. Mirrors the existing role rules:
//   Users + Laboratories: Super Admin (MIS) only.   Computers + Equipment: Super Admin (MIS) and MIS Staff (Inventory Staff).
// Save as PDF keeps each page's own existing predicate (passed in as `pdf`), so PDF access is never widened here.
export const TEMPLATE_ENDPOINTS = {
  users: '/users/import-template',
  laboratories: '/laboratories/import-template',
  computers: '/computers/import-template',
  equipment: '/equipment/import-template'
}
const MANAGE_ROLES = { users: ['MIS'], laboratories: ['MIS'], computers: ['MIS', 'Inventory Staff'], equipment: ['MIS', 'Inventory Staff'] }

export function getFileActions(module, role, { pdf = false } = {}) {
  const manage = (MANAGE_ROLES[module] || []).includes(role)
  const items = []
  if (manage) items.push({ key: 'import', label: 'Import Excel' }, { key: 'export', label: 'Export Excel' })
  if (pdf) items.push({ key: 'pdf', label: 'Save as PDF' })
  return items
}
