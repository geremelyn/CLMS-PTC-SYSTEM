const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { positiveInteger, requiredText } = require('../utils/recordValidation.js')

function getMaintenance(request, response) {
    const sql = `
        SELECT
            maintenance.*,
            users.full_name AS reported_by_name,
            users.username AS reported_by_username,
            users.program AS reported_by_program,
            users.role AS reported_by_role,
            computers.asset_tag AS computer_asset_tag,
            computers.computer_name,
            equipment.asset_tag AS equipment_asset_tag,
            equipment.equipment_type
        FROM maintenance
        LEFT JOIN users ON maintenance.reported_by = users.id
        LEFT JOIN computers ON maintenance.computer_id = computers.id
        LEFT JOIN equipment ON maintenance.equipment_id = equipment.id
        ORDER BY maintenance.date_reported DESC`

    db.query(sql, (error, results) => {
        if (error) {
            console.error('Unable to retrieve maintenance records:', error.code || error.message)
            return response.status(500).json({ message: 'Unable to retrieve maintenance records.' })
        }
        return response.status(200).json({ maintenance: results })
    })
}

function createMaintenance(request, response) {
    const rawComputerId = request.body?.computer_id
    const rawEquipmentId = request.body?.equipment_id
    const rawLaboratoryId = request.body?.laboratory_id
    const hasComputer = rawComputerId != null && String(rawComputerId).trim() !== ''
    const hasEquipment = rawEquipmentId != null && String(rawEquipmentId).trim() !== ''
    const computer_id = hasComputer ? positiveInteger(rawComputerId) : null
    const equipment_id = hasEquipment ? positiveInteger(rawEquipmentId) : null
    const laboratory_id = positiveInteger(rawLaboratoryId)
    // CP61 (optional): the equipment type chosen in the Report Issue form; when sent it must match the selected equipment record.
    const rawEquipmentType = request.body?.equipment_type
    const hasEquipmentType = rawEquipmentType != null && String(rawEquipmentType).trim() !== ''
    const equipmentTypeFilter = hasEquipmentType ? String(rawEquipmentType).trim() : ''
    const issue_description = String(request.body?.issue_description || '').trim()
    const reported_by = request.user?.id

    if (reported_by === undefined || reported_by === null) {
        return response.status(401).json({ message: 'Authentication required.' })
    }

    if (hasComputer && !computer_id || hasEquipment && !equipment_id) {
        return response.status(400).json({ message: 'Computer and equipment IDs must be positive whole numbers.' })
    }
    if ((!computer_id && !equipment_id) || (computer_id && equipment_id)) {
        return response.status(400).json({ message: 'Select exactly one computer or equipment item.' })
    }

    if (hasEquipmentType && (typeof rawEquipmentType !== 'string' || equipmentTypeFilter.length > 100)) {
        return response.status(400).json({ message: 'Equipment type is invalid.' })
    }
    if (hasEquipmentType && !equipment_id) {
        return response.status(400).json({ message: 'An equipment type can only be sent together with an equipment item.' })
    }

    if (!laboratory_id) {
        return response.status(400).json({ message: 'Please select a laboratory using a valid positive whole-number ID.' })
    }

    if (!requiredText(issue_description) || issue_description.length > 2000) {
        return response.status(400).json({ message: 'Issue description is required and must be 2,000 characters or fewer.' })
    }

    const checkAsset = (callback) => {
        if (computer_id) {
            return db.query(
                'SELECT id, laboratory_id, computer_name, asset_tag FROM computers WHERE id = ?',
                [computer_id],
                (error, rows) => {
                    if (error) return callback(error)
                    if (!rows.length) return callback(Object.assign(new Error('Computer not found.'), { statusCode: 404 }))
                    if (Number(rows[0].laboratory_id) !== laboratory_id) return callback(Object.assign(new Error('The selected computer does not belong to the selected laboratory.'), { statusCode: 400 }))
                    callback(null)
                }
            )
        }

        return db.query(
            `SELECT e.id, e.laboratory_id, c.laboratory_id AS computer_laboratory_id, e.equipment_type, e.asset_tag
             FROM equipment e
             LEFT JOIN computers c ON e.computer_id = c.id
             WHERE e.id = ?`,
            [equipment_id],
            (error, rows) => {
                if (error) return callback(error)
                if (!rows.length) return callback(Object.assign(new Error('Equipment not found.'), { statusCode: 404 }))
                const effectiveLaboratoryId = rows[0].laboratory_id ?? rows[0].computer_laboratory_id
                if (Number(effectiveLaboratoryId) !== laboratory_id) return callback(Object.assign(new Error('The selected equipment does not belong to the selected laboratory.'), { statusCode: 400 }))
                if (hasEquipmentType && String(rows[0].equipment_type ?? '').trim().toLocaleLowerCase() !== equipmentTypeFilter.toLocaleLowerCase()) return callback(Object.assign(new Error('The selected equipment does not match the selected equipment type.'), { statusCode: 400 }))
                callback(null)
            }
        )
    }

    checkAsset((assetError) => {
        if (assetError) {
            if (!assetError.statusCode) console.error('Unable to check selected maintenance asset:', assetError.code || assetError.message)
            return response.status(assetError.statusCode || 500).json({
                message: assetError.statusCode ? assetError.message : 'Unable to verify the selected asset.'
            })
        }

        const insertSql = `
            INSERT INTO maintenance (computer_id, equipment_id, reported_by, issue_description)
            VALUES (?, ?, ?, ?)
        `

        function finishInsert(id, responseMessage = 'Maintenance report saved and sent to Inventory Staff.') {
            logAudit(reported_by, 'MAINTENANCE UPDATE', `Maintenance #${id} submitted`)
            return response.status(201).json({
                message: responseMessage,
                maintenance: { id, computer_id, equipment_id, reported_by, issue_description, status: 'PENDING' }
            })
        }

        db.query(insertSql, [computer_id, equipment_id, reported_by, issue_description], (insertError, insertResults) => {
            if (!insertError) return finishInsert(insertResults.insertId)

            // Legacy phpMyAdmin dumps may have maintenance.id as a plain INT instead
            // of AUTO_INCREMENT. In that case MariaDB can try id=0 repeatedly.
            // Repair the sequence and retry once with an explicit next id.
            if (insertError.code !== 'ER_DUP_ENTRY' || !String(insertError.message || '').toLowerCase().includes('primary')) {
                console.error('Unable to save maintenance report:', insertError.code || insertError.message)
                return response.status(500).json({ message: 'Unable to save maintenance report.' })
            }

            db.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM maintenance', (idError, idRows) => {
                if (idError) { console.error('Unable to prepare maintenance record ID:', idError.code || idError.message); return response.status(500).json({ message: 'Unable to prepare a maintenance record.' }) }
                const nextId = Math.max(1, Number(idRows[0]?.next_id || 1))
                db.query(
                    'INSERT INTO maintenance (id, computer_id, equipment_id, reported_by, issue_description) VALUES (?, ?, ?, ?, ?)',
                    [nextId, computer_id, equipment_id, reported_by, issue_description],
                    (retryError) => {
                        if (retryError) { console.error('Unable to retry maintenance insert:', retryError.code || retryError.message); return response.status(500).json({ message: 'Unable to save maintenance report.' }) }
                        finishInsert(nextId)
                    }
                )
            })
        })
    })
}

const FIXED_FINAL_CONDITIONS = ['WORKING', 'NOT WORKING', 'UNDER REPAIR', 'DAMAGED', 'MISSING', 'RETIRED']

async function updateMaintenance(request, response) {
    const id = Number(request.params?.id)
    let { status: requestedStatus, maintenance_note, final_condition } = request.body || {}
    // "Others" keeps the record open as IN PROGRESS and stores the custom label in status_other (ENUM unchanged).
    const isOtherStatus = requestedStatus === 'OTHERS'
    const statusOther = isOtherStatus ? String(request.body?.status_other ?? '').trim() : null
    const status = isOtherStatus ? 'IN PROGRESS' : requestedStatus
    const allowedStatuses = ['PENDING', 'IN PROGRESS', 'COMPLETED', 'CLOSED']
    if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid maintenance record ID.' })
    if (isOtherStatus && (!statusOther || statusOther.length > 100)) return response.status(400).json({ message: 'Enter a custom maintenance status of 100 characters or fewer.' })
    if (!allowedStatuses.includes(status)) return response.status(400).json({ message: 'Invalid maintenance status.' })
    // CP112: besides the five fixed conditions, a custom condition saved through "Others" (lookup_options) is accepted; it is
    // verified against that table once the asset type is known. The asset columns are VARCHAR(50), hence the length limit.
    if (typeof final_condition === 'string' && FIXED_FINAL_CONDITIONS.includes(final_condition.trim().toUpperCase())) final_condition = final_condition.trim().toUpperCase()
    const isFixedCondition = FIXED_FINAL_CONDITIONS.includes(final_condition)
    if (status === 'COMPLETED' && !isFixedCondition && !(typeof final_condition === 'string' && final_condition.trim() && final_condition.trim().length <= 50)) {
        return response.status(400).json({ message: 'Please select a valid final asset condition.' })
    }
    if (maintenance_note != null && (typeof maintenance_note !== 'string' || maintenance_note.length > 2000)) {
        return response.status(400).json({ message: 'Maintenance note must be 2,000 characters or fewer.' })
    }

    let connection
    let transactionStarted = false
    const query = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, result) => error ? reject(error) : resolve(result)))
    const transaction = method => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, acquired) => error ? reject(error) : resolve(acquired)))
        await transaction('beginTransaction')
        transactionStarted = true

        const rows = await query('SELECT * FROM maintenance WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Maintenance record not found.'), { httpStatus: 404 })
        const maintenance = rows[0]
        if (maintenance.status === 'CLOSED') throw Object.assign(new Error('Closed maintenance records can no longer be updated.'), { httpStatus: 400 })

        const allowedTransitions = {
            PENDING: ['PENDING', 'IN PROGRESS'],
            'IN PROGRESS': ['IN PROGRESS', 'COMPLETED'],
            COMPLETED: ['COMPLETED', 'CLOSED']
        }
        if (!allowedTransitions[maintenance.status]?.includes(status)) {
            throw Object.assign(new Error(`Cannot change maintenance from ${maintenance.status} to ${status}.`), { httpStatus: 400 })
        }

        if (status === 'COMPLETED' && !isFixedCondition) {
            const category = maintenance.computer_id ? 'computer_condition' : maintenance.equipment_id ? 'equipment_status' : null
            const saved = category ? await query('SELECT value FROM lookup_options WHERE category = ? AND value = ?', [category, final_condition.trim()]) : []
            if (!saved.length) throw Object.assign(new Error('That final asset condition is not available. Add it through Others first.'), { httpStatus: 400 })
            final_condition = saved[0].value
        }

        // Capture the state this update will change, so the update can be genuinely undone (no time limit).
        let assetBefore = null
        if ((status === 'IN PROGRESS' || status === 'COMPLETED') && (maintenance.computer_id || maintenance.equipment_id)) {
            const isComputer = Boolean(maintenance.computer_id)
            const before = await query(isComputer ? 'SELECT operational_status, `condition`, condition_note FROM computers WHERE id = ? FOR UPDATE' : 'SELECT status, condition_note FROM equipment WHERE id = ? FOR UPDATE', [isComputer ? maintenance.computer_id : maintenance.equipment_id])
            if (before.length) assetBefore = { table: isComputer ? 'computers' : 'equipment', id: isComputer ? maintenance.computer_id : maintenance.equipment_id, fields: before[0] }
        }

        if (status === 'IN PROGRESS') {
            const conditionNote = fitConditionNote(`Maintenance #${id}: ${maintenance.issue_description}`)
            if (maintenance.computer_id) {
                const linked = await query('SELECT id FROM computers WHERE id = ? FOR UPDATE', [maintenance.computer_id])
                if (!linked.length) throw Object.assign(new Error('The linked computer no longer exists. Refresh the record and try again.'), { httpStatus: 409 })
                await query("UPDATE computers SET operational_status = 'INACTIVE', `condition` = 'UNDER REPAIR', condition_note = ? WHERE id = ?", [conditionNote, maintenance.computer_id])
            } else if (maintenance.equipment_id) {
                const linked = await query('SELECT id FROM equipment WHERE id = ? FOR UPDATE', [maintenance.equipment_id])
                if (!linked.length) throw Object.assign(new Error('The linked equipment no longer exists. Refresh the record and try again.'), { httpStatus: 409 })
                await query("UPDATE equipment SET status = 'UNDER REPAIR', condition_note = ? WHERE id = ?", [conditionNote, maintenance.equipment_id])
            }
        }

        let dateResolved = maintenance.date_resolved
        if (status === 'COMPLETED' && !dateResolved) dateResolved = new Date()
        if (status === 'COMPLETED') {
            const finalConditionNote = final_condition === 'WORKING' ? null : fitConditionNote(`Maintenance #${id}: ${String(maintenance_note || '').trim() || maintenance.issue_description}`)
            if (maintenance.computer_id) {
                const linked = await query('SELECT id FROM computers WHERE id = ? FOR UPDATE', [maintenance.computer_id])
                if (!linked.length) throw Object.assign(new Error('The linked computer no longer exists. Refresh the record and try again.'), { httpStatus: 409 })
                const operationalStatus = final_condition === 'WORKING' ? 'ACTIVE' : 'INACTIVE'
                await query('UPDATE computers SET operational_status = ?, `condition` = ?, condition_note = ? WHERE id = ?', [operationalStatus, final_condition, finalConditionNote, maintenance.computer_id])
            } else if (maintenance.equipment_id) {
                const linked = await query('SELECT id FROM equipment WHERE id = ? FOR UPDATE', [maintenance.equipment_id])
                if (!linked.length) throw Object.assign(new Error('The linked equipment no longer exists. Refresh the record and try again.'), { httpStatus: 409 })
                await query('UPDATE equipment SET status = ?, condition_note = ? WHERE id = ?', [final_condition, finalConditionNote, maintenance.equipment_id])
            }
        }

        await query('UPDATE maintenance SET status = ?, status_other = ?, maintenance_note = ?, date_resolved = ? WHERE id = ?', [status, statusOther, String(maintenance_note || '').trim() || null, dateResolved, id])
        const undoSnapshot = { maintenance: { id, status: maintenance.status, status_other: maintenance.status_other ?? null, maintenance_note: maintenance.maintenance_note ?? null, date_resolved: plainDate(maintenance.date_resolved) }, after: { status, status_other: statusOther }, asset: assetBefore }
        const undoAction = await query('INSERT INTO undo_actions (entity_type, snapshot_json, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 36500 DAY))', ['maintenance', JSON.stringify(undoSnapshot), request.user?.id ?? null])
        await transaction('commit')
        transactionStarted = false
        logAudit(request.user?.id, 'MAINTENANCE UPDATE', `Maintenance #${id} moved to ${status}`)
        return response.status(200).json({
            message: 'Maintenance updated successfully',
            undoActionId: undoAction.insertId,
            maintenance: { id, status, maintenance_note: String(maintenance_note || '').trim() || null, date_resolved: dateResolved, final_condition: status === 'COMPLETED' ? final_condition : null }
        })
    } catch (error) {
        if (transactionStarted && connection) {
            try { await transaction('rollback') } catch (rollbackError) { console.error('Unable to roll back maintenance update:', rollbackError.message) }
        }
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        console.error('Unable to update maintenance:', error.code || error.message)
        return response.status(500).json({ message: 'Unable to update maintenance. No changes were saved.' })
    } finally {
        connection?.release()
    }
}

// Format a Date as a Manila-local DATETIME string so a restore writes back exactly what was read.
function plainDate(value) {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
}

// Undo a maintenance update made by the same user (no time limit), provided the record has not changed since.
// computers.condition_note / equipment.condition_note are VARCHAR(255); longer text made the whole update fail (HTTP 500).
function fitConditionNote(text) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length > 255 ? `${value.slice(0, 252)}...` : value
}

async function undoMaintenanceUpdate(request, response) {
    const undoId = Number(request.params?.undoId)
    if (!Number.isSafeInteger(undoId) || undoId <= 0) return response.status(400).json({ message: 'Invalid undo action ID.' })
    let connection, started = false
    const query = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, result) => error ? reject(error) : resolve(result)))
    const transaction = method => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, acquired) => error ? reject(error) : resolve(acquired)))
        await transaction('beginTransaction'); started = true
        const actions = await query('SELECT id, entity_type, snapshot_json, created_by, used_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM undo_actions WHERE id = ? FOR UPDATE', [undoId])
        if (!actions.length || actions[0].entity_type !== 'maintenance') throw Object.assign(new Error('Undo action not found.'), { httpStatus: 404 })
        const action = actions[0]
        if (action.used_at) throw Object.assign(new Error('This undo action has expired or was already used.'), { httpStatus: 409 })
        if (action.created_by == null || Number(action.created_by) !== Number(request.user?.id)) throw Object.assign(new Error('Only the user who made this update may undo it.'), { httpStatus: 403 })
        const snap = JSON.parse(action.snapshot_json)
        const current = await query('SELECT status, status_other FROM maintenance WHERE id = ? FOR UPDATE', [snap.maintenance.id])
        if (!current.length) throw Object.assign(new Error('The maintenance record no longer exists.'), { httpStatus: 409 })
        if (current[0].status !== snap.after.status || (current[0].status_other ?? null) !== (snap.after.status_other ?? null)) throw Object.assign(new Error('This record was changed after the update, so it can no longer be undone.'), { httpStatus: 409 })
        await query('UPDATE maintenance SET status = ?, status_other = ?, maintenance_note = ?, date_resolved = ? WHERE id = ?', [snap.maintenance.status, snap.maintenance.status_other, snap.maintenance.maintenance_note, snap.maintenance.date_resolved, snap.maintenance.id])
        if (snap.asset) {
            const f = snap.asset.fields
            if (snap.asset.table === 'computers') await query('UPDATE computers SET operational_status = ?, `condition` = ?, condition_note = ? WHERE id = ?', [f.operational_status, f.condition, f.condition_note ?? null, snap.asset.id])
            else await query('UPDATE equipment SET status = ?, condition_note = ? WHERE id = ?', [f.status, f.condition_note ?? null, snap.asset.id])
        }
        await query('UPDATE undo_actions SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [undoId])
        await transaction('commit'); started = false
        logAudit(request.user?.id, 'MAINTENANCE UPDATE UNDONE', `Maintenance #${snap.maintenance.id} restored to ${snap.maintenance.status}.`)
        return response.status(200).json({ message: 'Maintenance update undone.' })
    } catch (error) {
        if (started && connection) { try { await transaction('rollback') } catch { /* connection already unusable */ } }
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        console.error('Unable to undo maintenance update:', error.code || error.message)
        return response.status(500).json({ message: 'Unable to undo the maintenance update. No changes were made.' })
    } finally { connection?.release() }
}
module.exports={getMaintenance,createMaintenance,updateMaintenance,undoMaintenanceUpdate}