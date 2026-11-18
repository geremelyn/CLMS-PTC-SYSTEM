const { logAudit } = require('../utils/auditLogger.js')
const db = require ('../database/db.js')
const { positiveInteger, requiredText, conditionNoteError } = require('../utils/recordValidation.js')
const { checkOtherAssetIdentifiers } = require('../utils/assetIdentifierCheck.js')
const { syncComputerMaintenance } = require('../utils/computerMaintenanceSync.js')
function getComputers(request, response){
    const sql = 'SELECT * FROM computers'

    db.query(sql, (error, results) =>{
        if (error){
            return response.status(500).json({message:'Unable to retrieve computers'})
        }
        return response.status(200).json({
            computers:results
        })
    })
}

// CP178 A2: capacity is checked and the row inserted inside ONE transaction that first locks the laboratory row (SELECT ... FOR UPDATE).
// Two simultaneous creates for the same laboratory therefore run one after the other: the second waits, re-counts after the first commit and is
// refused with "Laboratory reached its limit" instead of both passing a stale count. Every early exit and every error rolls back; the connection is always released.
function inLaboratoryTransaction(laboratoryId, work, commitFailureMessage = 'Unable to create computer') {
    return new Promise((resolve, reject) => {
        db.getConnection((connectError, connection) => {
            if (connectError) return reject(Object.assign(connectError, { clmsMessage: 'Unable to check laboratory' }))
            const query = (sql, values, message) => new Promise((ok, fail) => connection.query(sql, values, (error, result) => error ? fail(Object.assign(error, message ? { clmsMessage: message } : {})) : ok(result)))
            const step = (method, message) => new Promise((ok, fail) => connection[method](error => error ? fail(Object.assign(error, { clmsMessage: message })) : ok()))
            ;(async () => {
                let began = false
                try {
                    await step('beginTransaction', 'Unable to check laboratory'); began = true
                    const outcome = await work(connection, query)
                    await step('commit', commitFailureMessage); began = false
                    resolve(outcome)
                } catch (error) {
                    if (began) { try { await step('rollback', 'rollback') } catch (rollbackError) { console.error('Unable to roll back computer create:', rollbackError.message) } }
                    reject(error)
                } finally { connection.release() }
            })()
        })
    })
}
function sendComputerCreateError(response, error) {
    if (error && error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'Asset tag or serial number already exists. Identifiers must be unique across Computers and Assets & Equipment.' })
    return response.status(500).json({ message: (error && error.clmsMessage) || 'Unable to create computer' })
}

function createComputer(request,response){
    const{computer_name, laboratory_id, asset_tag, serial_number,
         processor, ram, storage_capacity, storage_unit, storage_type, 
         operational_status,condition,condition_note} = request.body

         const normalizedLaboratoryId = positiveInteger(laboratory_id)
         if(
            !requiredText(computer_name)||!normalizedLaboratoryId||!requiredText(asset_tag)||!requiredText(serial_number)||!requiredText(processor)||!Number.isSafeInteger(Number(ram)) || Number(ram) <= 0 || !Number.isSafeInteger(Number(storage_capacity)) || Number(storage_capacity) <= 0 ||
            !requiredText(storage_unit)||!requiredText(storage_type)||!requiredText(operational_status)||!requiredText(condition)
         )
         {
            return response.status(400).json({message: 'All fields are required; RAM and storage capacity must be positive whole numbers.'})
         }
         const noteError = conditionNoteError(condition, condition_note)
         if (noteError) return response.status(400).json({ message: noteError })

    const insertSql = `
            INSERT INTO computers(
                computer_name,
                laboratory_id,
                asset_tag,
                serial_number,
                processor,
                ram,
                storage_capacity,
                storage_unit,
                storage_type,
                operational_status,
                \`condition\`,
                condition_note
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    const values = [
                computer_name.trim(),
                normalizedLaboratoryId,
                asset_tag.trim(),
                serial_number.trim(),
                processor.trim(),
                ram,
                storage_capacity,
                storage_unit.trim(),
                storage_type.trim(),
                operational_status.trim(),
                condition.trim(),
                condition_note?.trim() || null]

    inLaboratoryTransaction(normalizedLaboratoryId, async (connection, query) => {
        const laboratoryResults = await query('SELECT * FROM laboratories WHERE id=? FOR UPDATE', [normalizedLaboratoryId], 'Unable to check laboratory')
        if (laboratoryResults.length === 0) return { status: 404, body: { message: 'Laboratory not found' } }
        const laboratory = laboratoryResults[0]
        // Counted AFTER the laboratory row is locked, so a create that committed while this one waited is included.
        const countResults = await query('SELECT COUNT(*) AS registeredComputers FROM computers WHERE laboratory_id =?', [normalizedLaboratoryId], 'Unable to count registered computers')
        if (countResults[0].registeredComputers >= laboratory.capacity) return { status: 400, body: { message: 'Laboratory reached its limit' } }
        const duplicate = await new Promise((ok, fail) => checkOtherAssetIdentifiers(connection, 'computers', asset_tag.trim(), serial_number.trim(), (error, found) => error ? fail(Object.assign(error, { clmsMessage: 'Unable to verify asset identifiers.' })) : ok(found)))
        if (duplicate) return { status: 409, body: { message: 'Asset tag or serial number already exists on an equipment record.' } }
        const insertResults = await query(insertSql, values, 'Unable to create computer')
        return { insertId: insertResults.insertId }
    }).then(outcome => {
        if (outcome.status) return response.status(outcome.status).json(outcome.body)
        const insertResults = outcome
        logAudit(request.user?.id, 'WORKSTATION ASSIGNMENT', `Registered workstation ${computer_name} (${asset_tag}) in laboratory #${laboratory_id}`)
        // CP135: a computer registered as Not Working / custom non-working opens one Maintenance record (same guard as edits).
        return syncComputerMaintenance(db, { computerId: insertResults.insertId, before: 'WORKING', after: condition, note: condition_note, userId: request.user?.id }, (syncError, outcome) => {
            if (syncError) console.error('Computer maintenance sync failed:', syncError.code || syncError.message)
            else if (outcome.action === 'created') logAudit(request.user?.id, 'MAINTENANCE UPDATE', `Maintenance #${outcome.id} opened automatically: ${computer_name} (${asset_tag}) registered as ${condition}`)
            return response.status(201).json({
                message: 'Computer created successfully',
                computer: {
                    id: insertResults.insertId,
                    computer_name: computer_name.trim(),
                    laboratory_id: normalizedLaboratoryId,
                    asset_tag: asset_tag.trim(),
                    serial_number: serial_number.trim(),
                    processor,
                    ram,
                    storage_capacity,
                    storage_unit,
                    storage_type,
                    operational_status,
                    condition,
                    condition_note: condition_note?.trim() || null
                }
            })
        })
    }).catch(error => sendComputerCreateError(response, error))
}

function updateComputer(request, response){
    const {id} = request.params
    const {computer_name, laboratory_id, asset_tag, serial_number, processor, ram,
    storage_capacity, storage_unit, storage_type, operational_status,condition,condition_note
  } = request.body

  const normalizedId = positiveInteger(id)
  const normalizedLaboratoryId = positiveInteger(laboratory_id)
  if ( !normalizedId || !requiredText(computer_name) || !normalizedLaboratoryId || !requiredText(asset_tag) || !requiredText(serial_number) || !requiredText(processor) || !Number.isSafeInteger(Number(ram)) || Number(ram) <= 0 ||
  !Number.isSafeInteger(Number(storage_capacity)) || Number(storage_capacity) <= 0 || !requiredText(storage_unit) || !requiredText(storage_type) || !requiredText(operational_status) ||
  !requiredText(condition)) 

  {
  return response.status(400).json({
    message: 'All fields are required; RAM and storage capacity must be positive whole numbers.'
    })
  }

    const noteError = conditionNoteError(condition, condition_note)
    if (noteError) return response.status(400).json({ message: noteError })

const laboratorySql = 'SELECT * FROM laboratories WHERE ID =?'

db.query( laboratorySql,
    [normalizedLaboratoryId],(error,laboratoryResults)=>{
        if (error) {
            return response.status(500).json({
                message:'Unable to check laboratory'
            })
        }
        if(laboratoryResults.length ===0 ){
            return response.status(404).json({
                message:'Laboratory not found'
            })
        }
        const laboratory = laboratoryResults[0]
        const computerSql='SELECT * FROM computers WHERE id =?'
db.query(computerSql,[normalizedId],(computerError,computerResults)=>{

            if (computerError){
                return response.status(500).json({
                    message:'Unable to check computer'
                })
            }
            if (computerResults.length ===0 ){
                return response.status(404).json({
                    message:'Computer not found'
                })
            }
            const currentComputer = computerResults[0]

function finishUpdate(previousLaboratoryId, sync) {
    const moved = Number(previousLaboratoryId) !== Number(laboratory_id)
    logAudit(request.user?.id, moved ? 'WORKSTATION ASSIGNMENT' : 'ASSET UPDATE', moved ? `Transferred workstation ${computer_name} (${asset_tag}) to laboratory #${laboratory_id}` : `Updated workstation ${computer_name} (${asset_tag})`)
    const respond = (maintenance) => response.status(200).json({
        message:'Computer updated successfully',
        computer:{
            id, computer_name, laboratory_id, asset_tag, serial_number, processor, ram, storage_capacity, storage_unit,
            storage_type, operational_status,condition
        },
        maintenance
    })
    // CP115: Working -> non-working opens one Maintenance record; non-working -> Working completes the open ones (kept in history).
    // CP182: that sync now ran INSIDE the update transaction (computer row locked, "before" read under the lock), so it is already committed with the
    // condition change and commit order == sync order; here only the audit entries and the response are produced.
    if (sync.error) {
        // The computer itself is already saved; report the sync problem instead of failing the whole edit.
        console.error('Computer maintenance sync failed:', sync.error.code || sync.error.message)
        return respond({ action: 'error' })
    }
    const outcome = sync.outcome
    if (outcome.action === 'created') logAudit(request.user?.id, 'MAINTENANCE UPDATE', `Maintenance #${outcome.id} opened automatically: ${computer_name} (${asset_tag}) condition changed from Working to ${condition}`)
    if (outcome.action === 'closed') logAudit(request.user?.id, 'MAINTENANCE UPDATE', `${outcome.count} open maintenance record(s) completed automatically: ${computer_name} (${asset_tag}) is Working again`)
    return respond(outcome)
}

// CP182: shared by the same-laboratory and the transfer path. The maintenance sync runs on the SAME connection, inside the transaction, while the
// computer row is locked FOR UPDATE, with "before" = the condition read under that lock. Concurrent edits of one computer therefore commit AND sync in
// the same order (no more stale "before", no reversed syncs after commit). A failed sync statement is only logged (the edit stays saved, as before)
// unless it aborted the transaction (deadlock / lock-wait timeout), in which case the whole edit is rolled back and reported as a failure.
const syncInTransaction = (connection, lockedCondition) => new Promise((resolve, reject) => syncComputerMaintenance(connection,
  { computerId: normalizedId, before: lockedCondition, after: condition, note: condition_note, userId: request.user?.id },
  (error, outcome) => {
    if (error && ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) return reject(Object.assign(error, { clmsMessage: 'Unable to update computer' }))
    resolve({ error, outcome })
  }))
const handleUpdateError = updateError => {
  if (updateError && updateError.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'Asset tag or serial number already exists. Identifiers must be unique across Computers and Assets & Equipment.' })
  if (updateError && updateError.clmsMessage === 'Unable to update computer') { console.error('Update computer error:', updateError); return response.status(500).json({ message: 'Unable to update computer', error: updateError.message }) }
  return response.status(500).json({ message: (updateError && updateError.clmsMessage) || 'Unable to update computer' })
}
const UPDATE_SQL = `UPDATE computers SET computer_name = ?, laboratory_id = ?, asset_tag = ?,
        serial_number = ?,processor = ?,ram = ?,storage_capacity = ?,storage_unit = ?,storage_type = ?,
        operational_status = ?,\`condition\` = ?, condition_note = ? WHERE id = ?`
const updateValues = () => [computer_name.trim(), normalizedLaboratoryId, asset_tag.trim(), serial_number.trim(), processor.trim(), ram,
    storage_capacity, storage_unit, storage_type, operational_status, condition, condition_note?.trim() || null, normalizedId]
const checkIdentifiers = connection => new Promise((ok, fail) => checkOtherAssetIdentifiers(connection, 'computers', asset_tag.trim(), serial_number.trim(), (error, found) => error ? fail(Object.assign(error, { clmsMessage: 'Unable to verify asset identifiers.' })) : ok(found)))

function performUpdate() {
  // Same-laboratory edit: no capacity involved, so no laboratory lock - only the computer row lock (laboratory locks always come BEFORE the computer lock
  // in the transfer path and this path never needs one, so the two cannot deadlock).
  inLaboratoryTransaction(null, async (connection, query) => {
    const locked = await query('SELECT id, laboratory_id, `condition` FROM computers WHERE id = ? FOR UPDATE', [normalizedId], 'Unable to check computer')
    if (!locked.length) return { status: 404, body: { message: 'Computer not found' } }
    // CP180: decided from the unlocked pre-check. If a concurrent transfer moved the computer meanwhile, nothing is written; the request is
    // re-evaluated ONCE so it takes the locked, capacity-checked transfer path instead of moving the computer into a possibly full laboratory.
    if (Number(locked[0].laboratory_id) !== Number(currentComputer.laboratory_id)) return { moved: true }
    if (await checkIdentifiers(connection)) return { status: 409, body: { message: 'Asset tag or serial number already exists on an equipment record.' } }
    const result = await query(UPDATE_SQL + ` AND laboratory_id = ${Number(currentComputer.laboratory_id)}`, updateValues(), 'Unable to update computer')
    if (result.affectedRows === 0) return { moved: true }
    return { updated: true, previousLaboratoryId: locked[0].laboratory_id, sync: await syncInTransaction(connection, locked[0].condition) }
  }, 'Unable to update computer').then(outcome => {
    if (outcome.moved) {
      if (!request.clmsComputerUpdateRetried) { request.clmsComputerUpdateRetried = true; return updateComputer(request, response) }
      return response.status(409).json({ message: 'This computer was changed by another request. Please reload and try again.' })
    }
    if (outcome.status) return response.status(outcome.status).json(outcome.body)
    return finishUpdate(outcome.previousLaboratoryId, outcome.sync)
  }).catch(handleUpdateError)
}

if (Number(currentComputer.laboratory_id) !== normalizedLaboratoryId) {
  // CP179: a transfer into another laboratory counts the destination's computers inside ONE transaction. Both laboratory rows (source and
  // destination) are locked FOR UPDATE in ascending id order - the same order for every transfer, so two opposite transfers cannot deadlock -
  // then the computer row is locked and re-read, and the destination is re-counted (excluding this computer) before the UPDATE.
  // Creates lock only their own laboratory row, so they queue behind / ahead of a transfer into the same laboratory.
  const sourceLaboratoryId = Number(currentComputer.laboratory_id)
  const lockOrder = [...new Set([sourceLaboratoryId, normalizedLaboratoryId].filter(value => Number.isSafeInteger(value) && value > 0))].sort((x, y) => x - y)
  inLaboratoryTransaction(normalizedLaboratoryId, async (connection, query) => {
    let destination = null
    for (const labId of lockOrder) {
      const locked = await query('SELECT id, capacity FROM laboratories WHERE id = ? FOR UPDATE', [labId], 'Unable to check laboratory')
      if (labId === normalizedLaboratoryId) destination = locked[0] || null
    }
    if (!destination) return { status: 404, body: { message: 'Laboratory not found' } }
    const lockedComputer = await query('SELECT id, laboratory_id, `condition` FROM computers WHERE id = ? FOR UPDATE', [normalizedId], 'Unable to check computer')
    if (!lockedComputer.length) return { status: 404, body: { message: 'Computer not found' } }
    const previousLaboratoryId = lockedComputer[0].laboratory_id
    // If a concurrent request already moved this computer into the destination, it is not a new occupant and needs no capacity check.
    if (Number(previousLaboratoryId) !== normalizedLaboratoryId) {
      const countResults = await query('SELECT COUNT(*) AS registeredComputers FROM computers WHERE laboratory_id = ? AND id <> ?', [normalizedLaboratoryId, normalizedId], 'Unable to count registered computers')
      if (countResults[0].registeredComputers >= destination.capacity) return { status: 400, body: { message: 'Laboratory reached its limit' } }
    }
    const duplicate = await new Promise((ok, fail) => checkOtherAssetIdentifiers(connection, 'computers', asset_tag.trim(), serial_number.trim(), (error, found) => error ? fail(Object.assign(error, { clmsMessage: 'Unable to verify asset identifiers.' })) : ok(found)))
    if (duplicate) return { status: 409, body: { message: 'Asset tag or serial number already exists on an equipment record.' } }
    const result = await query(UPDATE_SQL, updateValues(), 'Unable to update computer')
    if (result.affectedRows === 0) return { status: 404, body: { message: 'Computer not found' } }
    return { updated: true, previousLaboratoryId, sync: await syncInTransaction(connection, lockedComputer[0].condition) }
  }, 'Unable to update computer').then(outcome => {
    if (outcome.status) return response.status(outcome.status).json(outcome.body)
    return finishUpdate(outcome.previousLaboratoryId, outcome.sync) // CP180/CP182: before-condition read under the row lock; sync already ran inside the transaction
  }).catch(handleUpdateError)

} else {
  performUpdate()
}
}
)
}

)
}

// CP74: DELETE /computers/:id used to run a raw "DELETE FROM computers" - it skipped the reference check and the Recycle Bin, so a computer
// that equipment or maintenance history still pointed at was removed (orphaning that history). It now goes through the same safe path the
// Computers page already uses (bulk-delete): linked computers are refused with an explanation, free ones go to the Recycle Bin and can be restored.
function deleteComputer(request, response){
    const id=positiveInteger(request.params.id)
    if (!id) return response.status(400).json({ message: 'Invalid computer ID.' })
    request.body = { ids: [id] }
    return require('./bulkRecordController.js').createBulkRecordController('computers').bulkDelete(request, response)
}

// Minimal computer record created from the Equipment form's "Computer Assignment -> Others" option.
// Only the name and laboratory are required here; the remaining specs can be completed later on the Computers page.
function createQuickComputer(request, response) {
    const computerName = String(request.body?.computer_name ?? '').trim().replace(/\s+/g, ' ')
    const laboratoryId = positiveInteger(request.body?.laboratory_id)
    if (!requiredText(computerName) || computerName.length > 100) return response.status(400).json({ message: 'Enter a computer name of 100 characters or fewer.' })
    if (!laboratoryId) return response.status(400).json({ message: 'Select a laboratory first.' })
    inLaboratoryTransaction(laboratoryId, async (connection, query) => {
        const labs = await query('SELECT id, capacity FROM laboratories WHERE id=? FOR UPDATE', [laboratoryId], 'Unable to check laboratory')
        if (!labs.length) return { status: 404, body: { message: 'Laboratory not found' } }
        const rows = await query('SELECT id, LOWER(computer_name) AS lname FROM computers WHERE laboratory_id=?', [laboratoryId], 'Unable to check existing computers')
        if (rows.some(row => row.lname === computerName.toLowerCase())) return { status: 409, body: { message: 'A computer with this name already exists in that laboratory.' } }
        if (rows.length >= labs[0].capacity) return { status: 400, body: { message: 'Laboratory reached its limit' } }
        const result = await query('INSERT INTO computers (computer_name, laboratory_id) VALUES (?, ?)', [computerName, laboratoryId], 'Unable to create computer')
        return { insertId: result.insertId }
    }).then(outcome => {
        if (outcome.status) return response.status(outcome.status).json(outcome.body)
        logAudit(request.user?.id, 'WORKSTATION ASSIGNMENT', `Quick-added workstation ${computerName} in laboratory #${laboratoryId} from the Equipment form`)
        return response.status(201).json({ message: 'Computer created successfully', computer: { id: outcome.insertId, computer_name: computerName, laboratory_id: laboratoryId, operational_status: 'ACTIVE', condition: 'WORKING' } })
    }).catch(error => response.status(500).json({ message: (error && error.clmsMessage) || 'Unable to create computer' }))
}

module.exports = {getComputers, createComputer, createQuickComputer, updateComputer,deleteComputer}