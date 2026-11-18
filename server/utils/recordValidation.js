'use strict'

const CONDITIONS_REQUIRING_NOTE = new Set(['UNDER REPAIR', 'DAMAGED', 'MISSING', 'RETIRED'])

function positiveInteger(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function requiredText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function conditionNoteError(condition, note) {
  const normalizedCondition = String(condition ?? '').trim().toUpperCase()
  if (normalizedCondition && normalizedCondition !== 'WORKING' && !requiredText(note)) {
    return 'A condition note is required for this condition.'
  }
  return null
}

module.exports = { positiveInteger, requiredText, conditionNoteError, CONDITIONS_REQUIRING_NOTE }
