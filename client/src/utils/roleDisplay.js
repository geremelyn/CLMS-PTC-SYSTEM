// CP69: a custom role keeps its own name in the UI ("Laboratory Assistant"), never "Others"/"Teacher". Permissions follow Teacher, identity does not.
// `source` is any object with role / role_other (a signed-in user) or reserved_by_role / reserved_by_role_other (a reservation row).
export function customRoleName(role, roleOther) {
  return role === 'Others' ? (String(roleOther || '').trim() || 'Others') : null
}
export function displayRoleName(role, roleOther, fallback = '') {
  return customRoleName(role, roleOther) || (role === 'Inventory Staff' ? 'MIS Staff' : role === 'MIS' ? 'Super Admin' : role) || fallback
}

// CP84: one greeting for every dashboard: "Welcome, [User Name]!". The Super Admin (MIS) account is shown as "Super Admin" everywhere in the app.
export function welcomeGreeting(user) {
  const name = user?.role === 'MIS' ? 'Super Admin' : (String(user?.full_name || '').trim() || displayRoleName(user?.role, user?.role_other, 'User'))
  return `Welcome, ${name}!`
}
