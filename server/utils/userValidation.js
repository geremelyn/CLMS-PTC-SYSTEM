'use strict'
const MANAGED_ROLES = ['Dean', 'Teacher', 'Inventory Staff']
// CP118: names a custom role may NOT use (built-in roles, their display labels, and the dropdown label itself). Compared case-insensitively.
const RESERVED_ROLE_NAMES = ['mis', 'super admin', 'mis head', 'mis staff', 'inventory staff', 'dean', 'teacher', 'others', 'custom']
const isReservedRoleName = name => RESERVED_ROLE_NAMES.includes(String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
function validateManagedUser(input = {}, { passwordRequired = false } = {}) {
  const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ')
  const surname = clean(input.surname) || null
  const first_name = clean(input.first_name) || null
  const middle_initial = clean(input.middle_initial).replace(/\./g, '').toUpperCase() || null
  // full_name stays the single stored display name used across the system; compose it from the parts when given.
  const full_name = surname && first_name ? `${first_name}${middle_initial ? ` ${middle_initial}.` : ''} ${surname}` : String(input.full_name ?? '').trim()
  const username = String(input.username ?? '').trim()
  const password = String(input.password ?? '')
  const requestedRole = String(input.role ?? '').trim()
  // "Others" is a custom-labelled account. It is stored with its OWN role value ('Others', never 'Teacher'),
  // so it can sign in and change its password but is not listed in any requireRole() permission list.
  const labelOnly = requestedRole === 'Others'
  const role_other = labelOnly ? clean(input.role_other) : null // CP118: inner spaces collapsed so "Lab  Aide" and "Lab Aide" are the same role
  const role = labelOnly ? 'Others' : requestedRole
  // Teacher program: BSIT, BSOA, or "Others" + a custom program name (the exact name is stored, never the word "Others").
  const programChoice = String(input.program ?? '').trim()
  const customProgram = clean(input.program_other)
  const programIsOthers = role === 'Teacher' && programChoice.toLowerCase() === 'others'
  // CP166 Part 7: typing a built-in program (any case) under Others stores the canonical BSIT / BSOA, never a second spelling such as "bsit".
  const builtInProgram = ['BSIT', 'BSOA'].find(item => item.toLowerCase() === customProgram.toLowerCase())
  const program = role !== 'Teacher' ? null : programIsOthers ? (builtInProgram || customProgram || null) : ['BSIT', 'BSOA'].includes(programChoice) ? programChoice : null
  if (!full_name || !username || (passwordRequired && !password) || !requestedRole) return { error: passwordRequired ? 'Full name, username, password and role are required.' : 'Full name, username and role are required.' }
  if (middle_initial && middle_initial.length > 3) return { error: 'Middle initial must be 3 characters or fewer.' }
  if (full_name.length > 100) return { error: 'Full name must be 100 characters or fewer.' }
  if (username.length > 50) return { error: 'Username/ID number must be 50 characters or fewer.' }
  if (labelOnly && !role_other) return { error: 'Enter the custom role for Others.' }
  if (labelOnly && role_other.length > 100) return { error: 'Custom role must be 100 characters or fewer.' }
  if (labelOnly && isReservedRoleName(role_other)) return { error: `"${role_other}" is a built-in role name. Enter a different custom role name.` }
  if (!labelOnly && !MANAGED_ROLES.includes(role)) return { error: passwordRequired ? 'Only Dean, Teacher, and Inventory Staff accounts may be created by MIS.' : 'Invalid role.' }
  if (programIsOthers && !customProgram) return { error: 'Enter the custom program name for Others.' }
  if (programIsOthers && customProgram.length > 100) return { error: 'Program name must be 100 characters or fewer.' }
  if (programIsOthers && customProgram.toLowerCase() === 'others') return { error: 'Enter the actual program name instead of the word "Others".' }
  if (!labelOnly && role === 'Teacher' && !program) return { error: 'Select a Program (BSIT, BSOA or Others) for teacher accounts.' }
  if (passwordRequired && password.length < 6) return { error: 'Password must be at least 6 characters.' }
  return { error: null, values: { full_name, username, password, role, program, role_other, labelOnly, surname, first_name, middle_initial } }
}
function validManagedUserId(value, { allowZero = false } = {}) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return false
  const number = Number(value)
  return Number.isSafeInteger(number) && (allowZero ? number >= 0 : number > 0)
}
module.exports = { MANAGED_ROLES, RESERVED_ROLE_NAMES, isReservedRoleName, validateManagedUser, validManagedUserId }
