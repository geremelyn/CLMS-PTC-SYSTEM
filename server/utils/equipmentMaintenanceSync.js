'use strict'
// CP117: keeps the Maintenance list in step with an equipment item's status (same idea as CP115 for Computers).
//   Non-working status (Under Repair, Damaged, Missing, or any custom "Others" status) -> one OPEN maintenance record (PENDING) is created,
//     unless the equipment already has an open one (it is reused - never duplicated).
//   Back to Working / Active -> the equipment's open records (PENDING / IN PROGRESS) are COMPLETED; they stay in Maintenance History.
// Meanings that are deliberately NOT treated as "needs maintenance": Working, Active (fine), Inactive (administratively out of use, not damaged)
// and Retired (end of life). Moving to Inactive / Retired never opens a record and never closes one.
// Custom statuses already require a condition note (CP116 rule), i.e. they describe a problem, so they are treated as non-working.
// Only a real CHANGE of status triggers anything; saving other fields with the same status does nothing. No schema change.
const OPEN_STATUSES = "('PENDING','IN PROGRESS')"
const norm = status => String(status ?? '').trim().toUpperCase()
const RETURNS_TO_WORKING = ['WORKING', 'ACTIVE']
const NOT_A_MAINTENANCE_NEED = ['WORKING', 'ACTIVE', 'INACTIVE', 'RETIRED']

const returnsToWorking = status => RETURNS_TO_WORKING.includes(norm(status))
const needsMaintenance = status => norm(status) !== '' && !NOT_A_MAINTENANCE_NEED.includes(norm(status))

function describeChange(before, after, note) {
  const a = String(after).trim(), b = String(before ?? '').trim()
  const text = `${b ? `Equipment status changed from ${b} to ${a}` : `Equipment registered with status ${a}`}${note && String(note).trim() ? `: ${String(note).trim()}` : ''}`
  return text.length > 255 ? `${text.slice(0, 254)}…` : text
}

// done(error, { action: 'created' | 'exists' | 'closed' | 'none' | 'skipped', id?, count? })   `before` is null for a newly registered item.
function syncEquipmentMaintenance(db, { equipmentId, before, after, note, userId }, done) {
  if (norm(before) === norm(after)) return done(null, { action: 'none' })
  if (needsMaintenance(after)) {
    if (!userId) return done(null, { action: 'skipped' })   // reported_by is NOT NULL; routes always have a signed-in user
    // One statement: the NOT EXISTS check and the insert cannot be split by a second request for the same equipment.
    const sql = `INSERT INTO maintenance (equipment_id, reported_by, issue_description)
                 SELECT ?, ?, ? FROM DUAL
                 WHERE NOT EXISTS (SELECT 1 FROM maintenance WHERE equipment_id = ? AND status IN ${OPEN_STATUSES})`
    return db.query(sql, [equipmentId, userId, describeChange(before, after, note), equipmentId], (error, result) => {
      if (error) return done(error)
      return done(null, result && result.affectedRows > 0 ? { action: 'created', id: result.insertId } : { action: 'exists' })
    })
  }
  if (returnsToWorking(after) && !returnsToWorking(before)) {   // Working <-> Active is no change in meaning: no maintenance SQL at all
    const sql = `UPDATE maintenance
                 SET status = 'COMPLETED', date_resolved = NOW(),
                     maintenance_note = COALESCE(maintenance_note, 'Resolved automatically: the equipment status was set back to ${norm(after) === 'ACTIVE' ? 'Active' : 'Working'}.')
                 WHERE equipment_id = ? AND status IN ${OPEN_STATUSES}`
    return db.query(sql, [equipmentId], (error, result) => {
      if (error) return done(error)
      return done(null, result && result.affectedRows > 0 ? { action: 'closed', count: result.affectedRows } : { action: 'none' })
    })
  }
  return done(null, { action: 'none' }) // Inactive / Retired: no record opened, open records left as they are
}

module.exports = { syncEquipmentMaintenance, needsMaintenance, returnsToWorking, describeChange }
