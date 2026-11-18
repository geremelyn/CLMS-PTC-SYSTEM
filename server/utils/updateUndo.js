'use strict'
// Genuine undo for edits to Laboratories and Users (used by the "Others" status/role flows).
//  - withUpdateUndo(table): route wrapper. Snapshots the row before the controller runs; if the controller succeeds it
//    snapshots the row again and stores {before, after} in undo_actions, then adds `undoActionId` to the JSON response.
//  - undoRecordUpdate: restores `before` only if the row still equals `after` (nobody changed it since), (no time limit),
//    by the same user, in one transaction.
// Only whitelisted columns are ever read or written. Passwords/hashes are never included.
const db = require('../database/db.js')
const { logAudit } = require('./auditLogger.js')

const TABLES = {
  laboratories: ['laboratory_name', 'capacity', 'status', 'status_other', 'available_from', 'available_until', 'booking_interval', 'available_date_from', 'available_date_until', 'unavailable_from', 'unavailable_until', 'used_from', 'used_until', 'reason'],
  users: ['full_name', 'surname', 'first_name', 'middle_initial', 'username', 'role', 'role_other', 'program', 'status']
}
const plain = value => value instanceof Date ? (Number.isNaN(value.getTime()) ? null : new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')) : (value ?? null)
const normalize = (table, row) => Object.fromEntries(TABLES[table].map(column => [column, plain(row[column])]))
const q = (executor, sql, values = []) => new Promise((resolve, reject) => executor.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
const selectRow = async (executor, table, id, lock = false) => (await q(executor, `SELECT ${TABLES[table].map(c => `\`${c}\``).join(', ')} FROM ${table} WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]))[0]

function withUpdateUndo(table) {
  return async (request, response, next) => {
    const id = Number(request.params.id)
    let before = null
    try { if (Number.isSafeInteger(id) && id > 0) before = await selectRow(db, table, id) } catch (error) { console.error('Undo snapshot (before) failed:', error.code || error.message) }
    const sendJson = response.json.bind(response)
    response.json = (body) => {
      if (!before || response.statusCode >= 300 || !body || body.undoActionId) return sendJson(body)
      selectRow(db, table, id).then(async after => {
        if (!after) return sendJson(body)
        const snapshot = { table, id, before: normalize(table, before), after: normalize(table, after) }
        const inserted = await q(db, 'INSERT INTO undo_actions (entity_type, snapshot_json, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 36500 DAY))', [`update:${table}`, JSON.stringify(snapshot), request.user?.id ?? null])
        sendJson({ ...body, undoActionId: inserted.insertId })
      }).catch(error => { console.error('Undo snapshot (after) failed; update itself succeeded:', error.code || error.message); sendJson(body) })
      return response
    }
    next()
  }
}

async function undoRecordUpdate(request, response) {
  const undoId = Number(request.params?.undoId)
  if (!Number.isSafeInteger(undoId) || undoId <= 0) return response.status(400).json({ message: 'Invalid undo action ID.' })
  let connection, started = false
  try {
    connection = await new Promise((resolve, reject) => db.getConnection((error, acquired) => error ? reject(error) : resolve(acquired)))
    await new Promise((resolve, reject) => connection.beginTransaction(error => error ? reject(error) : resolve())); started = true
    const actions = await q(connection, 'SELECT id, entity_type, snapshot_json, created_by, used_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM undo_actions WHERE id = ? FOR UPDATE', [undoId])
    const action = actions[0]
    if (!action || !String(action.entity_type).startsWith('update:')) throw Object.assign(new Error('Undo action not found.'), { httpStatus: 404 })
    if (action.used_at) throw Object.assign(new Error('This undo action has expired or was already used.'), { httpStatus: 409 })
    if (action.created_by == null || Number(action.created_by) !== Number(request.user?.id)) throw Object.assign(new Error('Only the user who made this change may undo it.'), { httpStatus: 403 })
    const snap = JSON.parse(action.snapshot_json)
    if (!TABLES[snap.table]) throw Object.assign(new Error('This change cannot be undone.'), { httpStatus: 409 })
    const current = await selectRow(connection, snap.table, snap.id, true)
    if (!current) throw Object.assign(new Error('The record no longer exists, so the change cannot be undone.'), { httpStatus: 409 })
    if (JSON.stringify(normalize(snap.table, current)) !== JSON.stringify(snap.after)) throw Object.assign(new Error('The record was changed after this update, so it can no longer be undone.'), { httpStatus: 409 })
    const columns = TABLES[snap.table]
    await q(connection, `UPDATE ${snap.table} SET ${columns.map(c => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map(c => snap.before[c] ?? null), snap.id])
    await q(connection, 'UPDATE undo_actions SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [undoId])
    await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve())); started = false
    logAudit(request.user.id, 'UPDATE UNDONE', `Restored ${snap.table} #${snap.id} to its previous values.`)
    return response.json({ message: 'Update undone. The previous values were restored.' })
  } catch (error) {
    if (started && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'Cannot undo: a previous unique value (such as the ID number) is now used by another record.' })
    console.error('Undo record update failed:', error.code || error.message)
    return response.status(500).json({ message: 'Unable to undo the update. No changes were made.' })
  } finally { connection?.release() }
}
module.exports = { withUpdateUndo, undoRecordUpdate, TABLES }
