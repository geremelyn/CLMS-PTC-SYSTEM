'use strict'
// CP106: the automatic expiry of PENDING reservations (CP81: declined after N days or when the start time arrived) was REMOVED on Sir JC's instruction.
// A PENDING reservation now stays PENDING, however old it is and even after its scheduled start time, until MIS / authorized MIS Staff manually
// approves or declines it (or an earlier overlapping request is decided first - CP105B). There is no background timer and no sweep on list load.
// What remains in this file are only the note markers used to recognise rows written by earlier versions / by CP105B:
//  - 'Automatically cancelled:' notes (CP25-CP80 auto-cancels and CP105B overlap cancellations) can never be restored with Undo cancellation.
//  - 'Automatically declined:' notes on reservations declined by the old CP81 sweep are kept as history; those rows are NOT changed or migrated.
const AUTO_DECLINE_NOTE_PREFIX = 'Automatically declined:'
const AUTO_CANCEL_NOTE_PREFIX = 'Automatically cancelled:'

// CP105B: same prefix, used for requests cancelled because an overlapping request was decided first (also makes them non-restorable).
const RESTORE_BLOCKED_NOTE_PREFIX = AUTO_CANCEL_NOTE_PREFIX

function isAutoCancelledNote(note) { return typeof note === 'string' && note.startsWith(AUTO_CANCEL_NOTE_PREFIX) }
function isAutoDeclinedNote(note) { return typeof note === 'string' && note.startsWith(AUTO_DECLINE_NOTE_PREFIX) }

module.exports = { AUTO_DECLINE_NOTE_PREFIX, AUTO_CANCEL_NOTE_PREFIX, RESTORE_BLOCKED_NOTE_PREFIX, isAutoCancelledNote, isAutoDeclinedNote }
