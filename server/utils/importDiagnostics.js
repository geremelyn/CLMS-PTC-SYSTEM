'use strict'
// Helpers that make Excel import problems readable without leaking internals.
const { SPECS, FIELD_MAPS, keyOf } = require('./importTemplates.js')
const { COMPUTER_REQUIRED, EQUIPMENT_REQUIRED } = require('./excelImportValidation.js')
const REQUIRED = {
  users: ['username', 'surname', 'first_name', 'role'],
  laboratories: ['laboratory_name', 'capacity'],
  computers: COMPUTER_REQUIRED, // the importer's own lists: one source of truth
  equipment: EQUIPMENT_REQUIRED
}
const GENERIC = 'The file could not be read as an Excel workbook. Make sure it is a valid .xlsx file saved from Excel (not password-protected). Nothing was saved.'
// Display names (template headers) of required columns that the sheet's header row does not provide.
function missingColumns(headers, type) {
  const present = new Set((headers || []).map(h => FIELD_MAPS[type][keyOf(h)]).filter(Boolean))
  // CP171: older equipment files have only a "Status" column (that held the Condition); they stay importable.
  if (type === 'equipment' && !present.has('status') && (headers || []).some(h => keyOf(h) === 'status')) present.add('status')
  const nameOf = field => (SPECS[type].columns.find(c => c.field === field) || {}).header || field
  return REQUIRED[type].filter(field => !present.has(field)).map(nameOf)
}
function missingColumnsMessage(sheetName, headers, type) {
  const missing = missingColumns(headers, type)
  if (!missing.length) return ''
  return `The sheet “${sheetName}” is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Keep the header row exactly as in the CLMS export or sample template.`
}
// Parser/validation errors thrown by our own code are plain Errors with readable text. Anything that looks like a database
// or programming error (SQL code/number/statement, TypeError, ...) is replaced by a generic message; the real error is only logged.
function userFacingMessage(error, fallback = GENERIC) {
  if (!error || !error.message) return fallback
  if (error.code || error.errno || error.sqlState || error.sql || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return fallback
  if (/\b(SELECT|INSERT|UPDATE|DELETE)\b.*\b(FROM|INTO|SET)\b|ER_[A-Z_]+|\bat .*\(.*:\d+:\d+\)|node_modules|[A-Za-z]:\\|\/home\//i.test(error.message)) return fallback
  return error.message
}
module.exports = { REQUIRED, missingColumns, missingColumnsMessage, userFacingMessage, GENERIC_IMPORT_MESSAGE: GENERIC }
