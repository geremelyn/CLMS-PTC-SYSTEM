'use strict'
// Row mapping + validation for the Laboratories and Users Excel imports.
// (Computers and Equipment keep using excelImportValidation.js.) Pure functions: easy to test.
const { validateLaboratoryInput } = require('./laboratoryValidation.js')
const { validateManagedUser } = require('./userValidation.js')
const headerKey = value => String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
const FIELDS = {
  laboratories: { 'laboratory name': 'laboratory_name', 'laboratory': 'laboratory_name', 'name': 'laboratory_name', 'capacity': 'capacity', 'status': 'status', 'status other': 'status_other', 'custom status': 'status_other', 'available from': 'available_from', 'available until': 'available_until', 'reason': 'reason' },
  users: { 'id number': 'username', 'username': 'username', 'surname': 'surname', 'last name': 'surname', 'first name': 'first_name', 'mi': 'middle_initial', 'middle initial': 'middle_initial', 'program': 'program', 'role': 'role', 'password': 'password' }
}
function mapRow(headers, values, type) {
  const data = {}
  headers.forEach((header, index) => { const field = FIELDS[type][headerKey(header)]; if (field && data[field] === undefined) data[field] = values[index] ?? '' })
  return data
}
const text = value => String(value ?? '').trim()
// Users: "Teacher" with a Program (or BSIT-Teacher / BSOA-Teacher), "Dean", "MIS Staff"/"Inventory Staff"; anything else is an Others label.
function normalizeUserRole(data) {
  const raw = text(data.role), lower = raw.toLowerCase()
  let program = text(data.program).toUpperCase() || null
  if (/^bsit[- ]teacher$/.test(lower)) return { role: 'Teacher', program: 'BSIT' }
  if (/^bsoa[- ]teacher$/.test(lower)) return { role: 'Teacher', program: 'BSOA' }
  if (lower === 'teacher') {
    // A program other than BSIT/BSOA is a custom program: keep its exact text (not upper-cased) via program "Others".
    const rawProgram = text(data.program)
    if (rawProgram && !['BSIT', 'BSOA'].includes(rawProgram.toUpperCase())) return { role: 'Teacher', program: 'Others', program_other: rawProgram }
    return { role: 'Teacher', program }
  }
  if (lower === 'dean') return { role: 'Dean', program: null }
  if (['mis staff', 'inventory staff'].includes(lower)) return { role: 'Inventory Staff', program: null }
  return { role: 'Others', role_other: raw, program: null }
}
function validateSimpleRows(rows, type, reference = {}) {
  const seen = new Set()
  const existing = new Set((reference.existing || []).map(value => text(value).toLowerCase()))
  return rows.map((raw, index) => {
    const rowNumber = Number(raw.rowNumber) || index + 2
    const input = { ...(raw.data || raw) }
    const errors = []
    let data
    if (type === 'laboratories') {
      const status = text(input.status).toUpperCase()
      const known = ['OPEN', 'USED', 'UNAVAILABLE'].includes(status)
      const result = validateLaboratoryInput({ ...input, status: known ? status : 'OTHERS', status_other: known ? null : text(input.status_other) || text(input.status), reason: input.reason  }, { requireOthersReason: false })
      if (result.error) errors.push(result.error)
      data = result.values ? { ...result.values, reason: text(input.reason) || null } : input
      var key = text(data.laboratory_name).toLowerCase()
      if (key && existing.has(key)) errors.push(`Laboratory “${data.laboratory_name}” already exists.`)
    } else {
      const mapped = normalizeUserRole(input)
      const username = text(input.username)
      const password = text(input.password) || username
      const result = validateManagedUser({ ...input, ...mapped, role: mapped.role, role_other: mapped.role_other, password }, { passwordRequired: true })
      if (result.error) errors.push(!text(input.password) && /Password must be/.test(result.error) ? 'ID numbers shorter than 6 characters need a Password column value.' : result.error)
      data = result.values ? { ...result.values, password } : input
      key = username.toLowerCase()
      if (key && existing.has(key)) errors.push(`ID number “${username}” already exists.`)
    }
    if (key && seen.has(key)) errors.push('Duplicate of an earlier row in this file.'); else if (key) seen.add(key)
    return { rowNumber, data, errors, valid: errors.length === 0 }
  })
}
module.exports = { mapRow, validateSimpleRows, FIELDS, headerKey }
