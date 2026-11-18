const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { normalizeRecordIds } = require('../utils/bulkRecordValidation.js')
const CONFIG = {
  computers: { table: 'computers', columns: ['id','computer_name','laboratory_id','asset_tag','serial_number','processor','ram','storage_capacity','storage_unit','storage_type','operational_status','condition','condition_note'], action: 'COMPUTER BULK DELETE' },
  reservations: { table: 'reservations', columns: null, action: 'RESERVATION BULK DELETE' },
  // Recycle Bin only (not bulk-controller types): full row snapshot, restored by id.
  users: { table: 'users', columns: null, action: 'USER DELETE' },
  laboratories: { table: 'laboratories', columns: null, action: 'LABORATORY DELETE' },
  // Holidays are soft-deleted (is_active = 0) so a removed baseline date is never re-seeded; the Recycle Bin restores by re-activating.
  holidays: { table: 'holidays', columns: null, action: 'HOLIDAY DELETE' },
  // Maintenance records: full row snapshot. PENDING / COMPLETED / CLOSED may be deleted; IN PROGRESS may not (the asset is UNDER REPAIR because of it).
  maintenance: { table: 'maintenance', columns: null, action: 'MAINTENANCE BULK DELETE' },
  equipment: { table: 'equipment', columns: ['id','equipment_type','laboratory_id','computer_id','asset_tag','serial_number','brand','model','status','condition_note','reported_by','report_date'], action: 'EQUIPMENT BULK DELETE' }
}
// mysql2 returns Date objects; store them as Manila-local strings so a restore re-inserts the same values.
function plainValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
  return value ?? null
}
function recordLabel(type, record) {
  if (type === 'computers') return record.computer_name || record.asset_tag || `Computer #${record.id}`
  if (type === 'equipment') return record.equipment_type || record.asset_tag || `Equipment #${record.id}`
  if (type === 'maintenance') return `Maintenance #${record.id} (${record.status || 'PENDING'}${record.issue_description ? ': ' + String(record.issue_description).slice(0, 40) : ''})`
  if (type === 'users') return `${record.full_name || record.username} (${record.username})`
  if (type === 'laboratories') return record.laboratory_name || `Laboratory #${record.id}`
  if (type === 'holidays') return `${record.name || `Holiday #${record.id}`} (${String(record.holiday_date || '').slice(0, 10)})`
  return `Reservation #${record.id} (${String(plainValue(record.reservation_date) || '').slice(0, 10)} ${String(record.start_time || '').slice(0, 5)}-${String(record.end_time || '').slice(0, 5)})`
}
// Human-readable record information shown in the success popup AFTER a delete really succeeded. Never includes passwords/secrets.
function recordSummary(type, record) {
  const t = value => String(value ?? '').trim()
  const parts = []
  const add = (label, value) => { if (t(value)) parts.push(`${label}: ${t(value)}`) }
  if (type === 'computers') { add('Asset tag', record.asset_tag); add('Serial', record.serial_number); add('Status', record.operational_status); add('Condition', record.condition) }
  else if (type === 'equipment') { add('Type', record.equipment_type); add('Asset tag', record.asset_tag); add('Serial', record.serial_number); add('Brand/Model', [record.brand, record.model].filter(Boolean).join(' ')); add('Status', record.status) }
  else if (type === 'maintenance') { add('Status', record.status_other || record.status); add('Reported', String(plainValue(record.date_reported) || '').slice(0, 10)); add('Issue', String(record.issue_description || '').slice(0, 60)); add('Asset', record.computer_id ? `Computer #${record.computer_id}` : record.equipment_id ? `Equipment #${record.equipment_id}` : '') }
  else if (type === 'users') { add('Username', record.username); add('Role', record.role); add('Status', record.status) }
  else if (type === 'laboratories') { add('Capacity', record.capacity); add('Status', record.status); add('Hours', record.available_from && record.available_until ? `${String(record.available_from).slice(0, 5)}-${String(record.available_until).slice(0, 5)}` : '') }
  else if (type === 'holidays') { add('Date', String(record.holiday_date || '').slice(0, 10)); add('Type', record.holiday_type === 'OTHER' && record.custom_type_label ? record.custom_type_label : record.holiday_type) }
  else if (type === 'reservations') { add('Date', String(plainValue(record.reservation_date) || '').slice(0, 10)); add('Time', `${String(record.start_time || '').slice(0, 5)}-${String(record.end_time || '').slice(0, 5)}`); add('Status', record.status); add('Subject', record.subject_name) }
  return { id: record.id, label: String(recordLabel(type, record)), details: parts.join(' · ') }
}
function run(connection, sql, values = []) { return new Promise((resolve, reject) => connection.query(sql, values, (error, result) => error ? reject(error) : resolve(result))) }
function connectionFromPool() { return new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection))) }
// Maintenance statuses that may be deleted. IN PROGRESS is blocked: the linked asset was set to UNDER REPAIR by it.
const DELETABLE_MAINTENANCE_STATUSES = new Set(['PENDING', 'COMPLETED', 'CLOSED'])
// A restored maintenance row must still point at an existing asset and reporter (the asset may have been deleted since).
async function assertMaintenanceLinks(runQuery, record) {
  const exists = async (table, id) => id == null || (await runQuery(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id])).length > 0
  if (!await exists('computers', record.computer_id)) throw Object.assign(new Error('Cannot restore: the computer this maintenance record belongs to no longer exists. Restore the computer first.'), { httpStatus: 409 })
  if (!await exists('equipment', record.equipment_id)) throw Object.assign(new Error('Cannot restore: the equipment this maintenance record belongs to no longer exists. Restore the equipment first.'), { httpStatus: 409 })
  if (!await exists('users', record.reported_by)) throw Object.assign(new Error('Cannot restore: the user who reported this issue no longer exists. Restore the account first.'), { httpStatus: 409 })
}
const MAX_BULK_IDS = 5000
const CHUNK = 200
const chunk = (items, size) => { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out }
const isRetryable = error => error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT'
function createBulkRecordController(type) {
  const config = CONFIG[type]
  // Delete Selected and Delete All share this one path (CP13 Final):
  //  - up to MAX_BULK_IDS ids, processed in chunks inside ONE transaction (no oversized statement);
  //  - ids are locked in ascending order (consistent lock order -> fewer deadlocks between concurrent bulk operations);
  //  - a record deleted by someone else meanwhile, or still referenced elsewhere, is SKIPPED and REPORTED (never silent);
  //  - nothing deletable -> 409 and nothing is changed; deletedCount/skippedCount always match what really happened.
  // `skipLinked` is still accepted for older clients; Selected and All now behave identically.
  async function bulkDelete(request, response) {
    const ids = normalizeRecordIds(request.body?.ids).sort((a, b) => a - b)
    if (!ids.length || ids.length > MAX_BULK_IDS) return response.status(400).json({ message: `Select between 1 and ${MAX_BULK_IDS} records to delete.` })
    let connection, transaction = false
    try {
      connection = await connectionFromPool()
      await new Promise((resolve, reject) => connection.beginTransaction(error => error ? reject(error) : resolve())); transaction = true
      const marks = part => part.map(() => '?').join(',')
      let records = []
      for (const part of chunk(ids, CHUNK)) records.push(...await run(connection, `SELECT * FROM ${config.table} WHERE id IN (${marks(part)}) FOR UPDATE`, part))
      records = records.filter(record => ids.includes(Number(record.id)))
      const skipped = []
      const present = new Set(records.map(record => Number(record.id)))
      for (const id of ids) if (!present.has(id)) skipped.push({ id, label: `#${id}`, reason: 'No longer exists (deleted by someone else).' })
      // Records still referenced elsewhere keep their history: they are skipped, not deleted.
      const linkSpecs = type === 'computers'
        ? [['equipment', 'computer_id', 'equipment'], ['maintenance', 'computer_id', 'maintenance history']]
        : type === 'equipment' ? [['maintenance', 'equipment_id', 'maintenance history']] : []
      const linkedReasons = new Map(), linkedRefs = new Map()
      for (const [table, column, name] of linkSpecs) {
        for (const part of chunk([...present], CHUNK)) for (const row of await run(connection, `SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IN (${marks(part)})`, part)) {
          const id = Number(row.id); linkedReasons.set(id, [...(linkedReasons.get(id) || []), name])
        }
        // CP55: for maintenance history also look up WHICH maintenance records hold the reference (id, status, date), only for
        // the assets that are actually blocked, so a refused delete can be traced. Read-only; nothing is changed or hidden.
        if (table === 'maintenance') {
          const blocked = [...present].filter(id => (linkedReasons.get(id) || []).includes(name))
          for (const part of chunk(blocked, CHUNK)) for (const row of await run(connection, `SELECT m.${column} AS asset_id, m.id AS ref_id, m.status AS ref_status, m.date_reported AS ref_date, m.computer_id AS ref_computer_id FROM maintenance m WHERE m.${column} IN (${marks(part)}) ORDER BY m.id`, part)) {
            const id = Number(row.asset_id)
            linkedRefs.set(id, [...(linkedRefs.get(id) || []), { table, id: Number(row.ref_id), status: row.ref_status ?? null, reported: row.ref_date ? String(plainValue(row.ref_date)).slice(0, 10) : null, alsoComputerId: column === 'equipment_id' ? (row.ref_computer_id ?? null) : null }])
          }
        }
      }
      const refText = id => {
        const refs = linkedRefs.get(id) || []
        if (!refs.length) return ''
        const shown = refs.slice(0, 3).map(ref => `Maintenance #${ref.id}${ref.status ? ` ${ref.status}` : ''}${ref.reported ? `, reported ${ref.reported}` : ''}${ref.alsoComputerId ? `, also linked to computer #${ref.alsoComputerId}` : ''}`).join('; ')
        return ` (${shown}${refs.length > 3 ? `; and ${refs.length - 3} more` : ''})`
      }
      // Maintenance: IN PROGRESS records are never deleted (reported, not hidden).
      const statusBlocked = new Set()
      if (type === 'maintenance') for (const record of records) if (!DELETABLE_MAINTENANCE_STATUSES.has(String(record.status || '').toUpperCase())) { statusBlocked.add(Number(record.id)); skipped.push({ id: Number(record.id), label: recordLabel(type, record), reason: `${String(record.status || 'IN PROGRESS').toUpperCase()} records cannot be deleted: the asset is under repair. Complete or close it first.` }) }
      for (const record of records) if (linkedReasons.has(Number(record.id))) skipped.push({ id: Number(record.id), label: recordLabel(type, record), reason: `Still referenced by ${linkedReasons.get(Number(record.id)).join(' and ')}${refText(Number(record.id))}.`, references: linkedRefs.get(Number(record.id)) || [] })
      const deletable = records.filter(record => !linkedReasons.has(Number(record.id)) && !statusBlocked.has(Number(record.id)))
      // CP74: tell the user what to do about a blocked computer (history is never deleted or hidden to get around the block).
      const computerHint = () => type === 'computers' && skipped.some(item => item.reason.startsWith('Still referenced'))
        ? ' What to do: open the Equipment page and move or delete the equipment linked to this computer first. A computer with maintenance history is kept for the record and cannot be deleted - set its condition to RETIRED or its status to INACTIVE instead.'
        : ''
      const skippedText = () => skipped.length ? ` ${skipped.length} skipped: ${skipped.slice(0, 3).map(item => `${item.label} — ${item.reason}`).join(' ')}${skipped.length > 3 ? ` (and ${skipped.length - 3} more)` : ''}${computerHint()}` : ''
      if (!deletable.length) {
        await new Promise(resolve => connection.rollback(() => resolve())); transaction = false
        const allLinked = skipped.length && skipped.every(item => item.reason.startsWith('Still referenced'))
        return response.status(409).json({ message: `Nothing was deleted.${allLinked ? (type === 'equipment' ? ' Every selected record is still referenced by maintenance history.' : ' Every selected record is still referenced by equipment or maintenance history.') : ''}${skippedText()}`, deletedCount: 0, skippedCount: skipped.length, skipped })
      }
      const snapshots = deletable.map(record => Object.fromEntries((config.columns || Object.keys(record)).map(column => [column, plainValue(record[column])])))
      const action = await run(connection, `INSERT INTO undo_actions (entity_type, snapshot_json, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 36500 DAY))`, [type, JSON.stringify(snapshots), request.user?.id ?? null])
      for (const part of chunk(snapshots, CHUNK)) await run(connection, 'INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES ?', [part.map(snapshot => [type, snapshot.id, String(recordLabel(type, snapshot)).slice(0, 255), JSON.stringify(snapshot), request.user?.id ?? null])])
      const deleteIds = snapshots.map(snapshot => Number(snapshot.id))
      let removedCount = 0
      for (const part of chunk(deleteIds, CHUNK)) removedCount += Number((await run(connection, `DELETE FROM ${config.table} WHERE id IN (${marks(part)})`, part)).affectedRows || 0)
      if (removedCount !== deleteIds.length) throw new Error('Delete count mismatch')
      await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve())); transaction = false
      logAudit(request.user?.id, config.action, `Deleted ${deleteIds.length} ${type} records (${skipped.length} skipped); undo action #${action.insertId} (no time limit).`)
      return response.json({ message: `${deleteIds.length} record${deleteIds.length === 1 ? '' : 's'} deleted.${skippedText()} Undo or restore it any time.`, undoActionId: action.insertId, deletedCount: deleteIds.length, skippedCount: skipped.length, skipped, deletedRecords: snapshots.map(snapshot => recordSummary(type, snapshot)) })
    } catch (error) {
      if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
      if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
      if (isRetryable(error)) return response.status(409).json({ message: 'Another update is in progress. Nothing was deleted. Refresh and try again.' })
      console.error(`Bulk ${type} delete failed:`, error.code || error.message)
      return response.status(500).json({ message: 'Bulk delete failed and was rolled back. Nothing was deleted.' })
    } finally { connection?.release() }
  }
  async function undoDelete(request, response) {
    const undoId = Number(request.params.undoId)
    if (!Number.isSafeInteger(undoId) || undoId <= 0) return response.status(400).json({ message: 'Invalid undo action ID.' })
    let connection, transaction = false
    try {
      connection = await connectionFromPool()
      await new Promise((resolve, reject) => connection.beginTransaction(error => error ? reject(error) : resolve())); transaction = true
      const actions = await run(connection, 'SELECT id, entity_type, snapshot_json, created_by, used_at, expires_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS seconds_since_created FROM undo_actions WHERE id = ? FOR UPDATE', [undoId])
      if (!actions.length || actions[0].entity_type !== type) throw Object.assign(new Error('Undo action not found.'), { httpStatus: 404 })
      const action = actions[0]
      if (action.used_at) throw Object.assign(new Error('This undo action has expired or was already used.'), { httpStatus: 409 })
      if (request.user?.role !== 'MIS' && (action.created_by == null || Number(action.created_by) !== Number(request.user?.id))) throw Object.assign(new Error('Only the user who performed this deletion or MIS may undo it.'), { httpStatus: 403 })
      const snapshots = JSON.parse(action.snapshot_json)
      if (!Array.isArray(snapshots) || !snapshots.length) throw Object.assign(new Error('The saved undo snapshot is invalid.'), { httpStatus: 409 })
      for (const record of snapshots) {
        if (type === 'maintenance') await assertMaintenanceLinks((sql, values = []) => run(connection, sql, values), record)
        const otherTable = type === 'computers' ? 'equipment' : 'computers'
        const identifiers = [record.asset_tag || null, record.serial_number || null]
        if (identifiers.some(Boolean)) {
          const sameTable = await run(connection, `SELECT id FROM ${config.table} WHERE (asset_tag = ? AND ? IS NOT NULL) OR (serial_number = ? AND ? IS NOT NULL) LIMIT 1`, [identifiers[0], identifiers[0], identifiers[1], identifiers[1]])
          const otherRecords = await run(connection, `SELECT id FROM ${otherTable} WHERE (asset_tag = ? AND ? IS NOT NULL) OR (serial_number = ? AND ? IS NOT NULL) LIMIT 1`, [identifiers[0], identifiers[0], identifiers[1], identifiers[1]])
          if (sameTable.length || otherRecords.length) throw Object.assign(new Error('Cannot restore because an asset tag or serial number has since been reused. No records were restored.'), { httpStatus: 409 })
        }
        const fields = config.columns || Object.keys(record)
        const placeholders = fields.map(() => '?').join(',')
        await run(connection, `INSERT INTO ${config.table} (${fields.map(field => `\`${field}\``).join(',')}) VALUES (${placeholders})`, fields.map(field => { if (field === 'report_date' && record[field]) { const date = new Date(record[field]); return Number.isNaN(date.getTime()) ? null : date }; return record[field] ?? null }))
      }
      await run(connection, `UPDATE recycle_bin SET restored_at = NOW(), restored_by = ? WHERE entity_type = ? AND restored_at IS NULL AND entity_id IN (${snapshots.map(() => '?').join(',')})`, [request.user?.id ?? null, type, ...snapshots.map(record => record.id)])
      const updated = await run(connection, 'UPDATE undo_actions SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [undoId])
      if (!updated.affectedRows) throw Object.assign(new Error('Undo action was already used.'), { httpStatus: 409 })
      await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve())); transaction = false
      logAudit(request.user?.id, `${config.action} UNDONE`, `Restored ${snapshots.length} ${type} records from undo action #${undoId}.`)
      return response.json({ message: `${snapshots.length} records restored successfully.`, restoredCount: snapshots.length })
    } catch (error) {
      if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
      if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'Cannot restore records because a record ID or unique asset identifier is now in use. No records were restored.' })
      console.error(`Undo bulk ${type} delete failed:`, error.code || error.message)
      return response.status(500).json({ message: 'Undo failed and was rolled back.' })
    } finally { connection?.release() }
  }
  return { bulkDelete, undoDelete }
}
module.exports = { createBulkRecordController, assertMaintenanceLinks, DELETABLE_MAINTENANCE_STATUSES, MAX_BULK_IDS, CHUNK, chunk, isRetryable, CONFIG, plainValue, recordLabel, recordSummary }
