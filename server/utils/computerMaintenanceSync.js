'use strict'
// CP115: keeps the Maintenance list in step with a computer's condition.
//   Working -> anything else : one OPEN maintenance record (PENDING) is created for the computer, unless it already has an open one.
//   anything else -> Working  : the computer's open records (PENDING / IN PROGRESS) are completed (they stay in Maintenance History).
// Only a real CHANGE of condition triggers this; saving other fields of an already non-working computer does nothing, so it can
// never create repeated entries. No schema change: it only uses the existing `maintenance` columns.
const OPEN_STATUSES = "('PENDING','IN PROGRESS')"
const isWorking = condition => String(condition ?? '').trim().toUpperCase() === 'WORKING'

function describeChange(after, note) {
  const text = `Computer condition changed from Working to ${String(after).trim()}${note && String(note).trim() ? `: ${String(note).trim()}` : ''}`
  return text.length > 255 ? `${text.slice(0, 254)}…` : text
}

// done(error, { action: 'created' | 'exists' | 'closed' | 'none' | 'skipped', id?, count? })
function syncComputerMaintenance(db, { computerId, before, after, note, userId }, done) {
  const wasWorking = isWorking(before), nowWorking = isWorking(after)
  if (wasWorking && !nowWorking) {
    if (!userId) return done(null, { action: 'skipped' })   // reported_by is NOT NULL; routes always have a signed-in user
    // One statement: the NOT EXISTS check and the insert cannot be split by a second request for the same computer.
    const sql = `INSERT INTO maintenance (computer_id, reported_by, issue_description)
                 SELECT ?, ?, ? FROM DUAL
                 WHERE NOT EXISTS (SELECT 1 FROM maintenance WHERE computer_id = ? AND status IN ${OPEN_STATUSES})`
    return db.query(sql, [computerId, userId, describeChange(after, note), computerId], (error, result) => {
      if (error) return done(error)
      return done(null, result && result.affectedRows > 0 ? { action: 'created', id: result.insertId } : { action: 'exists' })
    })
  }
  if (!wasWorking && nowWorking) {
    const sql = `UPDATE maintenance
                 SET status = 'COMPLETED', date_resolved = NOW(),
                     maintenance_note = COALESCE(maintenance_note, 'Resolved automatically: the computer condition was set back to Working.')
                 WHERE computer_id = ? AND status IN ${OPEN_STATUSES}`
    return db.query(sql, [computerId], (error, result) => {
      if (error) return done(error)
      return done(null, result && result.affectedRows > 0 ? { action: 'closed', count: result.affectedRows } : { action: 'none' })
    })
  }
  return done(null, { action: 'none' })
}

module.exports = { syncComputerMaintenance, isWorking, describeChange }
