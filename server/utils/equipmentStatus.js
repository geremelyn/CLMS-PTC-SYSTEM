// CP116: built-in Equipment statuses now include ACTIVE and INACTIVE (besides WORKING / UNDER REPAIR / DAMAGED / MISSING / RETIRED).
// ACTIVE and INACTIVE are plain administrative states like WORKING, so they do not need a condition note.
// Any other status (including custom "Others" statuses) keeps the existing rule: a condition note is required.
// Equipment-only on purpose: the shared recordValidation.conditionNoteError (also used by Computers) is not changed.
const { conditionNoteError } = require('./recordValidation.js')

const EQUIPMENT_DEFAULT_STATUSES = ['WORKING', 'ACTIVE', 'INACTIVE', 'NOT WORKING']   // CP136: earlier values (Under Repair, Damaged, Missing, Retired) stay valid on existing records
const NO_NOTE_STATUSES = ['WORKING', 'ACTIVE', 'INACTIVE']

const noteNotRequired = status => NO_NOTE_STATUSES.includes(String(status ?? '').trim().toUpperCase())
function equipmentNoteError(status, note) {
  return noteNotRequired(status) ? null : conditionNoteError(status, note)
}

module.exports = { EQUIPMENT_DEFAULT_STATUSES, NO_NOTE_STATUSES, noteNotRequired, equipmentNoteError }
