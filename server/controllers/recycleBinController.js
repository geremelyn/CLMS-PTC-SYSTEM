const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { CONFIG, plainValue, recordLabel, recordSummary, isRetryable, chunk, assertMaintenanceLinks } = require('./bulkRecordController.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')
const { checkReservableDate } = require('../utils/holidayService.js')
// CP128: teacher_schedules is a Recycle Bin type but NOT a bulk/export CONFIG type (rows are soft-deleted: deleted_at set, file kept).
const TYPES = [...Object.keys(CONFIG), 'teacher_schedules']
const run = (connection, sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, result) => error ? reject(error) : resolve(result)))
const conn = () => new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection)))
const step = (connection, method) => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
const MAX_BATCH = 5000
// Reservations that may be deleted (moved to the Recycle Bin). PENDING / APPROVED are still active and are never deleted.
const DELETABLE_RESERVATION_STATUSES = new Set(['COMPLETED', 'DECLINED', 'CANCELLED'])
const conflict = (message) => Object.assign(new Error(message), { httpStatus: 409 })

async function listRecycleBin(request, response) {
  const type = TYPES.includes(request.query?.type) ? request.query.type : null
  try {
    const rows = await new Promise((resolve, reject) => db.query(
      `SELECT recycle_bin.id, entity_type, entity_id, label, snapshot_json, deleted_at, users.full_name AS deleted_by_name
       FROM recycle_bin LEFT JOIN users ON users.id = recycle_bin.deleted_by
       WHERE restored_at IS NULL AND (entity_type <> 'teacher_schedules' OR recycle_bin.deleted_by IN (SELECT id FROM users WHERE role = 'MIS')) ${type ? 'AND entity_type = ?' : ''} ORDER BY deleted_at DESC, recycle_bin.id DESC LIMIT 1000`,
      type ? [type] : [], (error, result) => error ? reject(error) : resolve(result)))
    response.json({ items: rows.map(({ snapshot_json, ...row }) => { let snapshot = null; try { snapshot = JSON.parse(snapshot_json); delete snapshot.password } catch { /* corrupt snapshot is shown without detail */ } return { ...row, snapshot } }) })
  } catch (error) {
    console.error('Recycle bin list failed:', error.code || error.message)
    response.status(500).json({ message: 'Unable to load the Recycle Bin.' })
  }
}

async function assertRestorable(connection, type, record) {
  const exists = async (table, id) => id == null || (await run(connection, `SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id])).length > 0
  if (type === 'teacher_schedules') {
    const rows = await run(connection, 'SELECT id, deleted_at FROM teacher_schedules WHERE id = ? LIMIT 1', [record.id])
    if (!rows.length) throw conflict('The schedule file no longer exists, so it cannot be restored.')
    if (!rows[0].deleted_at) throw conflict('This schedule is already active.')
    return
  }
  if (type === 'holidays') {
    const rows = await run(connection, 'SELECT id, is_active FROM holidays WHERE id = ? LIMIT 1', [record.id])
    if (!rows.length) throw conflict('The holiday record no longer exists, so it cannot be restored.')
    if (Number(rows[0].is_active) === 1) throw conflict('This holiday is already active.')
    const clash = await run(connection, "SELECT id FROM holidays WHERE holiday_date = ? AND is_active = 1 AND id <> ? LIMIT 1", [String(record.holiday_date).slice(0, 10), record.id])
    if (clash.length) throw conflict('Cannot restore: another holiday is now active on that date.')
    return
  }
  if ((await run(connection, `SELECT id FROM ${CONFIG[type].table} WHERE id = ? LIMIT 1`, [record.id])).length) throw conflict('A record with this ID already exists, so it cannot be restored.')
  if (type === 'users') {
    if ((await run(connection, 'SELECT id FROM users WHERE username = ? LIMIT 1', [record.username])).length) throw conflict(`Cannot restore: the ID number "${record.username}" is now used by another account.`)
  } else if (type === 'laboratories') {
    if ((await run(connection, 'SELECT id FROM laboratories WHERE LOWER(laboratory_name) = LOWER(?) LIMIT 1', [record.laboratory_name])).length) throw conflict(`Cannot restore: a laboratory named "${record.laboratory_name}" already exists.`)
  } else if (type === 'computers' || type === 'equipment') {
    if (!await exists('laboratories', record.laboratory_id)) throw conflict('Cannot restore: the laboratory this record belonged to no longer exists.')
    if (type === 'computers') {
      // CP181: a restored computer counts against its laboratory exactly like a new one (same rule as Add Computer, transfers and Excel import).
      // The laboratory row is already locked FOR UPDATE by lockComputerLaboratories() (called before any read), so this count cannot race a create/transfer/import.
      const [lab] = await run(connection, 'SELECT capacity FROM laboratories WHERE id = ?', [record.laboratory_id])
      const [{ registeredComputers }] = await run(connection, 'SELECT COUNT(*) AS registeredComputers FROM computers WHERE laboratory_id = ?', [record.laboratory_id])
      if (lab && lab.capacity != null && Number(registeredComputers) >= Number(lab.capacity)) throw conflict(`Cannot restore: the laboratory this computer belonged to has reached its limit (${lab.capacity}). Free a place or increase the laboratory capacity first; the computer stays in the Recycle Bin.`)
    }
    if (type === 'equipment' && !await exists('computers', record.computer_id)) throw conflict('Cannot restore: the computer this equipment was attached to no longer exists.')
    for (const [column, value] of [['asset_tag', record.asset_tag], ['serial_number', record.serial_number]]) {
      if (!value) continue
      for (const table of ['computers', 'equipment']) if ((await run(connection, `SELECT id FROM ${table} WHERE \`${column}\` = ? LIMIT 1`, [value])).length) throw conflict(`Cannot restore: the ${column.replace('_', ' ')} "${value}" is now used by another record.`)
    }
  } else if (type === 'maintenance') {
    await assertMaintenanceLinks((sql, values = []) => run(connection, sql, values), record)
  } else {
    if (!await exists('laboratories', record.laboratory_id)) throw conflict('Cannot restore: the laboratory no longer exists.')
    if (!await exists('users', record.reserved_by)) throw conflict('Cannot restore: the user who made this reservation no longer exists.')
    if (RESERVATION_POLICY.conflictStatuses.includes(record.status)) {
      const t = value => { const x = String(value || '').slice(0, 8); return x.length === 5 ? `${x}:00` : x }
      const clash = await run(connection, `SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND status IN (${RESERVATION_POLICY.conflictStatusSql}) AND start_time < ? AND end_time > ? LIMIT 1`, [record.laboratory_id, String(record.reservation_date).slice(0, 10), t(record.end_time), t(record.start_time)])
      if (clash.length) throw conflict(`Cannot restore: another active reservation (${String(clash[0].start_time).slice(0, 5)}–${String(clash[0].end_time).slice(0, 5)}) now overlaps this laboratory, date and time.`)
    }
  }
}

// CP181: locks (FOR UPDATE, ascending id - the same order transfers and imports use) the laboratory rows of the computers about to be restored.
// Only locking reads are used here, so the transaction's consistent-read snapshot is taken AFTER the locks are granted and the later capacity count is current.
async function lockComputerLaboratories(connection, ids) {
  const rows = await run(connection, `SELECT id, snapshot_json FROM recycle_bin WHERE entity_type = 'computers' AND restored_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, ids)
  const labIds = [...new Set(rows.map(row => { try { return Number(JSON.parse(row.snapshot_json).laboratory_id) } catch { return NaN } }).filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b)
  for (const labId of labIds) await run(connection, 'SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [labId])
}

// Restores ONE Recycle Bin item inside the caller's transaction. Throws (with httpStatus) when it cannot be restored safely.
async function restoreOne(connection, id, userId) {
  const rows = await run(connection, 'SELECT * FROM recycle_bin WHERE id = ? FOR UPDATE', [id])
  if (!rows.length) throw Object.assign(new Error('Recycle Bin item not found.'), { httpStatus: 404 })
  const item = rows[0]
  if (item.restored_at) throw Object.assign(conflict('This item was already restored.'), { itemLabel: item.label })
  try {
    if (!TYPES.includes(item.entity_type)) throw conflict('This item type cannot be restored.')
    let record
    try { record = JSON.parse(item.snapshot_json) } catch { throw conflict('The saved snapshot is corrupt and cannot be restored.') }
    await assertRestorable(connection, item.entity_type, record)
    if (item.entity_type === 'teacher_schedules') {
      await run(connection, 'UPDATE teacher_schedules SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL', [record.id])
      await run(connection, 'UPDATE recycle_bin SET restored_at = NOW(), restored_by = ? WHERE id = ? AND restored_at IS NULL', [userId, id])
      return item
    }
    if (item.entity_type === 'holidays') {
      await run(connection, 'UPDATE holidays SET is_active = 1, updated_by = ? WHERE id = ?', [userId, record.id])
      await run(connection, 'UPDATE recycle_bin SET restored_at = NOW(), restored_by = ? WHERE id = ? AND restored_at IS NULL', [userId, id])
      // Re-evaluate the date: a restored closed holiday flags (never deletes) reservations already booked on it.
      item.holiday_sync = await require('./holidayController.js').syncFlagsForDate((sql, values = []) => run(connection, sql, values), String(record.holiday_date).slice(0, 10))
      return item
    }
    const fields = CONFIG[item.entity_type].columns || Object.keys(record)
    await run(connection, `INSERT INTO ${CONFIG[item.entity_type].table} (${fields.map(f => `\`${f}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(f => record[f] ?? null))
    await run(connection, 'UPDATE recycle_bin SET restored_at = NOW(), restored_by = ? WHERE id = ? AND restored_at IS NULL', [userId, id])
    // A restored PENDING/APPROVED reservation whose date has since become a holiday is kept (never lost) but FLAGGED for review.
    if (item.entity_type === 'reservations' && ['PENDING', 'APPROVED'].includes(record.status)) {
      const dateText = String(record.reservation_date).slice(0, 10)
      const check = await checkReservableDate((sql, values = []) => run(connection, sql, values), dateText)
      if (!check.ok && check.code === 'HOLIDAY') {
        const note = `${check.holiday.name} - date is now closed. Review, reschedule or cancel.`.slice(0, 255)
        await run(connection, 'UPDATE reservations SET holiday_flag = 1, holiday_flag_note = ?, holiday_flagged_at = NOW() WHERE id = ?', [note, record.id])
        item.holiday_flag_name = check.holiday.name
      }
    }
  } catch (error) { error.itemLabel = item.label || `#${item.entity_id}`; throw error }
  return item
}

function restoreFailure(response, error, many = false) {
  const suffix = many ? ' Nothing was restored.' : ''
  const named = many && error.itemLabel ? ` (${error.itemLabel})` : ''
  if (error.httpStatus) return response.status(error.httpStatus).json({ message: `${error.message}${named}${suffix}` })
  if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: `Cannot restore: a unique value (ID, asset tag or serial number) is now in use${named}.${suffix}` })
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return response.status(409).json({ message: `Cannot restore: a related record no longer exists${named}.${suffix}` })
  console.error('Recycle bin restore failed:', error.code || error.message)
  return response.status(500).json({ message: 'Restore failed and was rolled back.' })
}

async function restoreRecycleItem(request, response) {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid Recycle Bin item.' })
  let connection, transaction = false
  try {
    connection = await conn()
    await step(connection, 'beginTransaction'); transaction = true
    await lockComputerLaboratories(connection, [id])
    const item = await restoreOne(connection, id, request.user.id)
    await step(connection, 'commit'); transaction = false
    logAudit(request.user.id, 'RECYCLE BIN RESTORE', `Restored ${item.entity_type} #${item.entity_id} (${item.label || 'no label'}) from the Recycle Bin.`)
    response.json({ message: `${item.label || `Record #${item.entity_id}`} restored.${item.holiday_flag_name ? ` Note: its date is now ${item.holiday_flag_name} (closed), so it was flagged for review.` : ''}`, holidayFlagged: Boolean(item.holiday_flag_name) })
  } catch (error) {
    if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    restoreFailure(response, error)
  } finally { connection?.release() }
}

// Restore several items atomically (used by "Restore" after Delete All). All succeed or none do.
async function restoreRecycleItems(request, response) {
  const ids = [...new Set((Array.isArray(request.body?.ids) ? request.body.ids : []).map(Number))]
  if (!ids.length || ids.length > MAX_BATCH || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return response.status(400).json({ message: `Provide between 1 and ${MAX_BATCH} valid Recycle Bin items.` })
  let connection, transaction = false
  try {
    connection = await conn()
    await step(connection, 'beginTransaction'); transaction = true
    ids.sort((a, b) => a - b)
    for (const part of chunk(ids, 200)) await lockComputerLaboratories(connection, part)
    for (const id of ids) await restoreOne(connection, id, request.user.id)
    await step(connection, 'commit'); transaction = false
    logAudit(request.user.id, 'RECYCLE BIN RESTORE', `Restored ${ids.length} record(s) from the Recycle Bin.`)
    response.json({ message: `${ids.length} record${ids.length === 1 ? '' : 's'} restored.`, restoredCount: ids.length })
  } catch (error) {
    if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    restoreFailure(response, error, true)
  } finally { connection?.release() }
}

// ---- Permanent delete (MIS only) -------------------------------------------------------------------------------------
// Removes the SELECTED Recycle Bin items for good, in ONE transaction (all or nothing). What "related data" means here:
//  * the recycle_bin row (the saved snapshot) is deleted;
//  * a soft-deleted holiday (is_active = 0) is deleted from holidays; a live holiday is never touched;
//  * bulk-delete "Undo" snapshots (undo_actions) still holding the record are pruned, otherwise an old Undo could bring the
//    permanently deleted record back. Other records in the same Undo snapshot are kept; an emptied snapshot is marked used.
// Live records of other types are never deleted: they already left their tables when they were moved to the Recycle Bin.
async function pruneUndoSnapshots(connection, type, entityIds) {
  const wanted = new Set(entityIds.map(Number))
  for (const part of chunk([...wanted], 50)) {
    const where = part.map(() => '(snapshot_json LIKE ? OR snapshot_json LIKE ?)').join(' OR ')
    const patterns = part.flatMap(id => [`%"id":${id},%`, `%"id":${id}}%`])
    const rows = await run(connection, `SELECT id, snapshot_json FROM undo_actions WHERE entity_type = ? AND used_at IS NULL AND (${where}) FOR UPDATE`, [type, ...patterns])
    for (const row of rows) {
      let records; try { records = JSON.parse(row.snapshot_json) } catch { continue }
      if (!Array.isArray(records)) continue
      const kept = records.filter(record => !wanted.has(Number(record?.id)))
      if (kept.length === records.length) continue
      if (kept.length) await run(connection, 'UPDATE undo_actions SET snapshot_json = ? WHERE id = ? AND used_at IS NULL', [JSON.stringify(kept), row.id])
      else await run(connection, 'UPDATE undo_actions SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [row.id])
    }
  }
}

async function permanentDeleteRecycleItems(request, response) {
  const raw = Array.isArray(request.body?.ids) ? request.body.ids : []
  if (!raw.length) return response.status(400).json({ message: 'Select at least one Recycle Bin record to delete permanently.' })
  const isId = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  const invalid = raw.filter(value => !isId(value)).length
  if (invalid) return response.status(400).json({ message: `${invalid} of the selected items ${invalid === 1 ? 'is' : 'are'} not valid Recycle Bin records. Refresh the page and select them again.` })
  const ids = [...new Set(raw.map(Number))].sort((a, b) => a - b)
  if (ids.length > MAX_BATCH) return response.status(400).json({ message: `Select at most ${MAX_BATCH} records at a time (you selected ${ids.length}).` })
  let connection, transaction = false
  try {
    connection = await conn()
    await step(connection, 'beginTransaction'); transaction = true
    const items = []
    for (const part of chunk(ids, 200)) items.push(...await run(connection, `SELECT id, entity_type, entity_id, label, restored_at FROM recycle_bin WHERE id IN (${part.map(() => '?').join(',')}) FOR UPDATE`, part))
    if (items.length !== ids.length) throw conflict('Some selected records are no longer in the Recycle Bin (already deleted or restored). Refresh the page. Nothing was deleted.')
    if (items.some(item => item.restored_at)) throw conflict('Some selected records were already restored. Refresh the page. Nothing was deleted.')
    const byType = new Map()
    for (const item of items) byType.set(item.entity_type, [...(byType.get(item.entity_type) || []), Number(item.entity_id)])
    for (const [type, entityIds] of byType) {
      if (type === 'holidays') {
        for (const part of chunk(entityIds, 200)) await run(connection, `DELETE FROM holidays WHERE is_active = 0 AND id IN (${part.map(() => '?').join(',')})`, part)
      } else if (type === 'teacher_schedules') {
        for (const part of chunk(entityIds, 200)) await run(connection, `DELETE FROM teacher_schedules WHERE deleted_at IS NOT NULL AND id IN (${part.map(() => '?').join(',')})`, part)
      } else await pruneUndoSnapshots(connection, type, entityIds)
    }
    let removed = 0
    for (const part of chunk(ids, 200)) removed += Number((await run(connection, `DELETE FROM recycle_bin WHERE restored_at IS NULL AND id IN (${part.map(() => '?').join(',')})`, part)).affectedRows || 0)
    if (removed !== ids.length) throw conflict('The Recycle Bin changed while deleting. Nothing was deleted. Refresh the page and try again.')
    await step(connection, 'commit'); transaction = false
    const labels = items.map(item => item.label || `${item.entity_type} #${item.entity_id}`)
    logAudit(request.user.id, 'RECYCLE BIN PERMANENT DELETE', `Permanently deleted ${ids.length} record(s) from the Recycle Bin: ${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ` and ${labels.length - 5} more` : ''}.`)
    response.json({ message: ids.length === 1 ? `${labels[0]} permanently deleted.` : `${ids.length} records permanently deleted.`, deletedCount: ids.length, deleted: labels.slice(0, 20) })
  } catch (error) {
    if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
    console.error('Recycle bin permanent delete failed:', error.code || error.message)
    response.status(500).json({ message: 'Permanent delete failed and was rolled back. Nothing was deleted.' })
  } finally { connection?.release() }
}

// MIS: delete reservations by moving them to the Recycle Bin (one transaction). There is NO expiry on restoring them.
async function deleteReservations(request, response) {
  // Each failure now says WHAT is wrong (CP17): empty selection, an invalid id, or too many ids in one request.
  const rawIds = Array.isArray(request.body?.ids) ? request.body.ids : null
  if (!rawIds || !rawIds.length) return response.status(400).json({ message: 'No reservations were selected to delete.' })
  const ids = [...new Set(rawIds.map(value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) ? Number(value) : NaN))].sort((a, b) => a - b) // ascending = consistent lock order
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    const bad = rawIds.filter(value => !((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) && Number.isSafeInteger(Number(value)) && Number(value) > 0))
    const shown = bad.slice(0, 5).map(value => JSON.stringify(value) ?? 'undefined').join(', ')
    return response.status(400).json({ message: `The request contained an invalid reservation id (${bad.length} of ${rawIds.length}: ${shown}${bad.length > 5 ? ', …' : ''}). Nothing was deleted. Refresh the page and try again.`, invalidIds: bad.slice(0, 20) })
  }
  if (ids.length > MAX_BATCH) return response.status(400).json({ message: `A single request can delete at most ${MAX_BATCH} reservations (received ${ids.length}). The page sends larger Delete All requests in batches automatically.` })
  let connection, transaction = false
  try {
    connection = await conn()
    await step(connection, 'beginTransaction'); transaction = true
    // Work in chunks inside ONE transaction so a large "Delete All" never builds one oversized statement/packet.
    // Reservations that disappeared since the list was loaded are skipped (reported), not treated as a failure.
    const CHUNK = 200
    const records = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      records.push(...await run(connection, `SELECT * FROM reservations WHERE id IN (${part.map(() => '?').join(',')}) FOR UPDATE`, part))
    }
    // Delete Selected and Delete All behave the same: a reservation deleted by someone else meanwhile is skipped AND reported
    // (skippedCount / skipped); if none of them still exist nothing is changed and the request fails with 409.
    if (!records.length) throw conflict('None of these reservations exist any more (they were deleted by someone else). Refresh the list.')
    // Only finished reservations may be deleted. PENDING and APPROVED ones are never touched: they are skipped and reported.
    // CP54: the status restriction belongs to Delete All only (`deleteAll: true`). An explicit selection (individual delete /
    // Delete Selected) is the Super Admin's deliberate choice and works for every status, as it did before CP53.
    const deleteAll = request.body?.deleteAll === true
    const isEligible = record => !deleteAll || DELETABLE_RESERVATION_STATUSES.has(String(record.status || '').toUpperCase())
    const eligible = records.filter(isEligible)
    const ineligible = records.filter(record => !isEligible(record))
    if (!eligible.length) throw conflict(`None of the selected reservations can be deleted: only Completed, Declined and Cancelled reservations can be deleted. ${ineligible.length} Pending/Approved reservation${ineligible.length === 1 ? ' was' : 's were'} left untouched.`)
    records.splice(0, records.length, ...eligible)
    const foundIds = records.map(record => Number(record.id))
    const snapshots = records.map(record => Object.fromEntries(Object.keys(record).map(column => [column, plainValue(record[column])])))
    for (let i = 0; i < snapshots.length; i += CHUNK) {
      await run(connection, 'INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ?', [snapshots.slice(i, i + CHUNK).map(snapshot => ['reservations', snapshot.id, String(recordLabel('reservations', snapshot)).slice(0, 255), JSON.stringify(snapshot), request.user.id])])
    }
    let removedCount = 0
    const recycleIds = []
    for (let i = 0; i < foundIds.length; i += CHUNK) {
      const part = foundIds.slice(i, i + CHUNK), partMarks = part.map(() => '?').join(',')
      const removed = await run(connection, `DELETE FROM reservations WHERE id IN (${partMarks})`, part)
      removedCount += Number(removed.affectedRows || 0)
      recycleIds.push(...(await run(connection, `SELECT id FROM recycle_bin WHERE entity_type = 'reservations' AND restored_at IS NULL AND entity_id IN (${partMarks}) ORDER BY id`, part)).map(row => row.id))
    }
    if (removedCount !== foundIds.length) throw new Error('Reservation delete count mismatch')
    const found = new Set(foundIds), ineligibleIds = new Set(ineligible.map(record => Number(record.id)))
    const skippedMissing = ids.filter(id => !found.has(id) && !ineligibleIds.has(id)).map(id => ({ id, label: `Reservation #${id}`, reason: 'No longer exists (deleted by someone else).' }))
    const skippedActive = ineligible.map(record => ({ id: Number(record.id), label: `Reservation #${record.id}`, reason: `${String(record.status).toUpperCase()} reservations cannot be deleted.` }))
    const skipped = [...skippedMissing, ...skippedActive], skippedCount = skipped.length
    await step(connection, 'commit'); transaction = false
    logAudit(request.user.id, 'RESERVATION DELETE', `Moved ${foundIds.length} reservation(s) to the Recycle Bin.`)
    const skipNotes = []
    if (skippedActive.length) skipNotes.push(`${skippedActive.length} Pending/Approved reservation${skippedActive.length === 1 ? ' was' : 's were'} left untouched.`)
    if (skippedMissing.length) skipNotes.push(`${skippedMissing.length} could not be deleted because ${skippedMissing.length === 1 ? 'it was' : 'they were'} already deleted by someone else.`)
    response.json({ message: `Successfully deleted ${foundIds.length} reservation${foundIds.length === 1 ? '' : 's'}.${skipNotes.length ? ' ' + skipNotes.join(' ') : ''}`, deletedCount: foundIds.length, skippedCount, skipped, recycleIds, deletedRecords: snapshots.map(snapshot => recordSummary('reservations', snapshot)) })
  } catch (error) {
    if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
    if (isRetryable(error)) return response.status(409).json({ message: 'Another update is in progress. Nothing was deleted. Refresh and try again.' })
    console.error('Reservation delete failed; rolled back:', error.code || error.message)
    response.status(500).json({ message: 'Unable to delete reservations. Nothing was deleted.' })
  } finally { connection?.release() }
}

// Users / Laboratories: move to the Recycle Bin ONLY when nothing else still depends on the record. The schema has no
// foreign keys, so these checks are the safety net: a record that is in use is skipped (never silently deleted) and the
// reason is returned. blockers(connection, records, request) -> Map(id -> reason).
function createSafeDelete(type, noun, blockers) {
  return async function safeDelete(request, response) {
    const ids = [...new Set((Array.isArray(request.body?.ids) ? request.body.ids : []).map(Number))].sort((a, b) => a - b)
    if (!ids.length || ids.length > MAX_BATCH || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return response.status(400).json({ message: `Select between 1 and ${MAX_BATCH} ${noun}s to delete.` })
    let connection, transaction = false
    try {
      connection = await conn()
      await step(connection, 'beginTransaction'); transaction = true
      const marks = ids.map(() => '?').join(',')
      const records = await run(connection, `SELECT * FROM ${CONFIG[type].table} WHERE id IN (${marks}) FOR UPDATE`, ids)
      const blocked = await blockers(connection, records, request)
      const skipped = ids.filter(id => !records.some(record => record.id === id)).map(id => ({ id, label: `#${id}`, reason: 'No longer exists.' }))
      for (const record of records) if (blocked.has(record.id)) skipped.push({ id: record.id, label: recordLabel(type, record), reason: blocked.get(record.id) })
      const deletable = records.filter(record => !blocked.has(record.id))
      if (!deletable.length) {
        await step(connection, 'rollback'); transaction = false
        return response.status(409).json({ deletedCount: 0, skippedCount: skipped.length, message: `Nothing was deleted. ${skipped.slice(0, 3).map(item => `${item.label}: ${item.reason}`).join(' ')}${skipped.length > 3 ? ` (and ${skipped.length - 3} more)` : ''}`, skipped })
      }
      const snapshots = deletable.map(record => Object.fromEntries(Object.keys(record).map(column => [column, plainValue(record[column])])))
      await run(connection, 'INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ?', [snapshots.map(snapshot => [type, snapshot.id, String(recordLabel(type, snapshot)).slice(0, 255), JSON.stringify(snapshot), request.user.id])])
      const deleteIds = deletable.map(record => record.id)
      const removed = await run(connection, `DELETE FROM ${CONFIG[type].table} WHERE id IN (${deleteIds.map(() => '?').join(',')})`, deleteIds)
      if (removed.affectedRows !== deleteIds.length) throw new Error('Delete count mismatch')
      const binRows = await run(connection, `SELECT id FROM recycle_bin WHERE entity_type = ? AND restored_at IS NULL AND entity_id IN (${deleteIds.map(() => '?').join(',')}) ORDER BY id`, [type, ...deleteIds])
      await step(connection, 'commit'); transaction = false
      logAudit(request.user.id, `${type.toUpperCase()} DELETE`, `Moved ${deleteIds.length} ${noun}(s) to the Recycle Bin.`)
      const skippedText = skipped.length ? ` ${skipped.length} could not be deleted: ${skipped.slice(0, 3).map(item => `${item.label} — ${item.reason}`).join(' ')}${skipped.length > 3 ? ` (and ${skipped.length - 3} more)` : ''}` : ''
      response.json({ message: `Successfully deleted ${deleteIds.length} ${noun}${deleteIds.length === 1 ? '' : 's'}.${skippedText}`, deletedCount: deleteIds.length, skippedCount: skipped.length, skipped, recycleIds: binRows.map(row => row.id), deletedRecords: snapshots.map(snapshot => recordSummary(type, snapshot)) })
    } catch (error) {
      if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
      if (isRetryable(error)) return response.status(409).json({ message: `Another update is in progress. Nothing was deleted. Refresh and try again.` })
      console.error(`${type} delete failed; rolled back:`, error.code || error.message)
      response.status(500).json({ message: `Unable to delete ${noun}s. Nothing was deleted.` })
    } finally { connection?.release() }
  }
}
const countBy = async (connection, sql, ids) => { const result = new Map(); for (const row of await run(connection, sql, ids)) result.set(Number(row.id), (result.get(Number(row.id)) || 0) + Number(row.total)); return result }
const userBlockers = async (connection, records, request) => {
  const blocked = new Map(), ids = records.map(record => record.id)
  for (const record of records) {
    if (record.role === 'MIS') blocked.set(record.id, 'MIS accounts cannot be deleted.')
    else if (record.id === request.user.id) blocked.set(record.id, 'You cannot delete your own account.')
  }
  const candidates = ids.filter(id => !blocked.has(id))
  if (candidates.length) {
    const marks = candidates.map(() => '?').join(',')
    const sources = [
      ['reservation history', ['reserved_by', 'decided_by', 'cancelled_by'].map(column => `SELECT ${column} AS id, COUNT(*) AS total FROM reservations WHERE ${column} IN (${marks}) GROUP BY ${column}`)],
      ['maintenance reports', [`SELECT reported_by AS id, COUNT(*) AS total FROM maintenance WHERE reported_by IN (${marks}) GROUP BY reported_by`]],
      ['recorded equipment', [`SELECT reported_by AS id, COUNT(*) AS total FROM equipment WHERE reported_by IN (${marks}) GROUP BY reported_by`]]
    ]
    const reasons = new Map()
    for (const [name, queries] of sources) for (const sql of queries) for (const [id, total] of await countBy(connection, sql, candidates)) if (total) reasons.set(id, [...(reasons.get(id) || []).filter(item => item !== name), name])
    for (const [id, names] of reasons) blocked.set(id, `Has ${names.join(', ')}. Deactivate the account instead of deleting it.`)
  }
  return blocked
}
const laboratoryBlockers = async (connection, records) => {
  const blocked = new Map(), ids = records.map(record => record.id)
  if (!ids.length) return blocked
  const marks = ids.map(() => '?').join(',')
  const parts = new Map()
  for (const [name, table] of [['computer', 'computers'], ['equipment record', 'equipment'], ['reservation', 'reservations']]) {
    for (const [id, total] of await countBy(connection, `SELECT laboratory_id AS id, COUNT(*) AS total FROM ${table} WHERE laboratory_id IN (${marks}) GROUP BY laboratory_id`, ids)) if (total) parts.set(id, [...(parts.get(id) || []), `${total} ${name}${total === 1 ? '' : 's'}`])
  }
  for (const [id, list] of parts) blocked.set(id, `Still in use by ${list.join(', ')}. Move or delete those first.`)
  return blocked
}
const deleteUsers = createSafeDelete('users', 'user', userBlockers)
const deleteLaboratories = createSafeDelete('laboratories', 'laboratory', laboratoryBlockers)

module.exports = { listRecycleBin, restoreRecycleItem, restoreRecycleItems, permanentDeleteRecycleItems, deleteReservations, deleteUsers, deleteLaboratories }
