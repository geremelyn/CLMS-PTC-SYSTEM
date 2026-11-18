const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { positiveInteger, requiredText } = require('../utils/recordValidation.js')
const { equipmentNoteError } = require('../utils/equipmentStatus.js')
const { checkOtherAssetIdentifiers } = require('../utils/assetIdentifierCheck.js')
const { syncEquipmentMaintenance } = require('../utils/equipmentMaintenanceSync.js')

// CP117: open / reuse / complete the equipment's Maintenance record after a saved status change; failures never undo the equipment save.
function syncAndAudit(request, { equipmentId, before, after, note, label }, respond) {
    syncEquipmentMaintenance(db, { equipmentId, before, after, note, userId: request.user?.id }, (syncError, outcome) => {
        if (syncError) { console.error('Equipment maintenance sync failed:', syncError.code || syncError.message); return respond({ action: 'error' }) }
        if (outcome.action === 'created') logAudit(request.user?.id, 'MAINTENANCE UPDATE', `Maintenance #${outcome.id} opened automatically: ${label} status ${before ? `changed from ${before} to ${after}` : `is ${after}`}`)
        if (outcome.action === 'closed') logAudit(request.user?.id, 'MAINTENANCE UPDATE', `${outcome.count} open maintenance record(s) completed automatically: ${label} is ${String(after).trim()} again`)
        return respond(outcome)
    })
}

function getEquipment(request, response){
    const sql=`
        SELECT e.*, COALESCE(e.laboratory_id, c.laboratory_id) AS effective_laboratory_id,
               reporter.full_name AS added_by_name, reporter.username AS reported_by_username
        FROM equipment e
        LEFT JOIN computers c ON e.computer_id = c.id
        LEFT JOIN users reporter ON e.reported_by = reporter.id
        ORDER BY e.id
    `

    db.query(sql,(error,results)=>{
        if(error){
            return response.status(500).json({
                message:'Unable to retrieve equipment'
            })
        }
        return response.status(200).json({
            equipment: results
        })
    })
}
// CP164: Status (Active / Inactive / custom) is separate from Condition (`status`: Working / Not Working / custom).
// A missing equipment_state defaults to ACTIVE (older clients, imports). Old values ACTIVE / INACTIVE in `status` still save and still never open maintenance.
function normalizeState(rawState) {
    const value = String(rawState ?? 'ACTIVE').trim().toUpperCase()
    if (!value || value.length > 50) return { error: 'Status is required and must be 50 characters or fewer.' }
    return { value }
}

function createEquipment(request,response){
    const{
        equipment_type,
        laboratory_id,
        computer_id,
        asset_tag,
        serial_number,
        brand,
        model,
        status,
        condition_note
    }=request.body
    const stateResult = normalizeState(request.body.equipment_state)
    if (stateResult.error) return response.status(400).json({ message: stateResult.error })
    const equipmentState = stateResult.value

    const normalizedLaboratoryId = positiveInteger(laboratory_id)
    const normalizedComputerId = computer_id == null || computer_id === '' ? null : positiveInteger(computer_id)
    if (!requiredText(equipment_type) || !normalizedLaboratoryId || !requiredText(asset_tag) || !requiredText(serial_number) || !requiredText(status) || (computer_id != null && computer_id !== '' && !normalizedComputerId)) {
        return response.status(400).json({ message: 'Equipment type, valid laboratory, asset tag, serial number, and status are required. If supplied, computer assignment must be a valid ID.' })
    }
    const noteError = equipmentNoteError(status, condition_note)
    if (noteError) return response.status(400).json({ message: noteError })

    function insertEquipment(){
        checkOtherAssetIdentifiers(db, 'equipment', asset_tag.trim(), serial_number.trim(), (identifierError, duplicate) => {
        if (identifierError) return response.status(500).json({ message: 'Unable to verify asset identifiers.' })
        if (duplicate) return response.status(409).json({ message: 'Asset tag or serial number already exists on a computer record.' })
        const insertSql=`INSERT INTO equipment(
        equipment_type,
        laboratory_id,
        computer_id,
        asset_tag,
        serial_number,
        brand,
        model,
        equipment_state,
        status,
        condition_note,
        reported_by,
        report_date
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        const values =[
            equipment_type.trim(),
            normalizedLaboratoryId,
            normalizedComputerId,
            asset_tag.trim(),
            serial_number.trim(),
            brand?.trim() || null,
            model?.trim() || null,
            equipmentState,
            status.trim(),
            condition_note?.trim() || null,
            request.user?.id || null,
            new Date()]

            db.query(insertSql,values,(insertError,insertResults)=>{

                if(insertError){
                    if(insertError.code ==='ER_DUP_ENTRY'){
                        return response.status(409).json({
                            message:'Asset tag or serial number already exists. Identifiers must be unique across Computers and Assets & Equipment.'
                        })
                    }
                    return response.status(500).json({
                        message:'Unable to create equipment'})
                }
                logAudit(request.user?.id, 'ASSET ASSIGNMENT / UPDATE', `Registered asset ${equipment_type} (${asset_tag}) in laboratory #${laboratory_id}`)
                return syncAndAudit(request, { equipmentId: insertResults.insertId, before: null, after: status.trim(), note: condition_note, label: `${equipment_type} (${asset_tag.trim()})` }, maintenance => response.status(201).json({
                    message:'Equipment created successfully',
                    equipment:{
                        id: insertResults.insertId,
                        equipment_type,
                        laboratory_id: normalizedLaboratoryId,
                        computer_id: normalizedComputerId,
                        asset_tag: asset_tag.trim(),
                        serial_number: serial_number.trim(),
                        brand: brand||null,
                        model: model ||null,
                        status
                    },
                    maintenance
                }))
            })
        })
    }

    const laboratorySql ='SELECT * FROM laboratories WHERE id =?'
    db.query(laboratorySql, [normalizedLaboratoryId], (error, laboratoryResults)=>{
    
        if (error){
            return response.status(500).json({
                message:'Unable to check laboratory'
            })
        }
        if(laboratoryResults.length ===0){
            return response.status(404).json({
                message: 'laboratory not found'
            })
        }

        if(normalizedComputerId){
            const computerSql ='SELECT * FROM computers WHERE id=?'

            db.query(computerSql,[normalizedComputerId],(computerError, computerResults)=>{

                if(computerError){
                    return response.status(500).json({
                        message:'Unable to check computer'
                    })
                }
                if(computerResults.length ===0){
                    return response.status(404).json({
                        message: 'Computer not found'
                    })
                }
                const computer = computerResults[0]
                if(Number(computer.laboratory_id)!==normalizedLaboratoryId){
                    return response.status(400).json({
                        message:'Selected computer does not belong to this laboratory'
                    })
                }
                insertEquipment()

            })
        }
        else{
            insertEquipment()
        }
    }
)

}

function updateEquipment(request,response){
    const{id}=request.params
    const{
        equipment_type,laboratory_id,computer_id,
        asset_tag,serial_number,brand,model,status,condition_note }=request.body
    const stateResult = normalizeState(request.body.equipment_state)
    if (stateResult.error) return response.status(400).json({ message: stateResult.error })
    const equipmentState = stateResult.value

    const normalizedId = positiveInteger(id)
    const normalizedLaboratoryId = positiveInteger(laboratory_id)
    const normalizedComputerId = computer_id == null || computer_id === '' ? null : positiveInteger(computer_id)
    if (!normalizedId || !requiredText(equipment_type) || !normalizedLaboratoryId || !requiredText(asset_tag) || !requiredText(serial_number) || !requiredText(status) || (computer_id != null && computer_id !== '' && !normalizedComputerId)) {
        return response.status(400).json({ message: 'Equipment ID, type, valid laboratory, asset tag, serial number, and status are required. If supplied, computer assignment must be a valid ID.' })
    }
    const noteError = equipmentNoteError(status, condition_note)
    if (noteError) return response.status(400).json({ message: noteError })

    function performUpdate() {
    checkOtherAssetIdentifiers(db, 'equipment', asset_tag.trim(), serial_number.trim(), (identifierError, duplicate) => {
    if (identifierError) return response.status(500).json({ message: 'Unable to verify asset identifiers.' })
    if (duplicate) return response.status(409).json({ message: 'Asset tag or serial number already exists on a computer record.' })
    db.query('SELECT status FROM equipment WHERE id = ?', [normalizedId], (beforeError, beforeRows) => {
    if (beforeError) return response.status(500).json({ message: 'Unable to update equipment' })
    const previousStatus = beforeRows && beforeRows[0] ? beforeRows[0].status : null
    const updateSql = 
            `UPDATE equipment
            SET equipment_type = ?,
            laboratory_id = ?,
            computer_id = ?,
            asset_tag = ?,
            serial_number = ?,
            brand = ?,
            model = ?,
            equipment_state = ?,
            status = ?,
            condition_note = ?
            WHERE id = ?`

    const values = [
            equipment_type,
            normalizedLaboratoryId,
            normalizedComputerId,
            asset_tag.trim(),
            serial_number.trim(),
            brand?.trim() || null,
            model?.trim() || null,
            equipmentState,
            status,
            condition_note?.trim() || null,
            normalizedId
            ]

    db.query(updateSql,values,(updateError, updateResults) => {
        if(updateError){
            if(updateError.code ==='ER_DUP_ENTRY'){
                return response.status(400).json({
                    message:'Asset tag or serial number already exists'
                })
            }
            return response.status(500).json({
                message: 'Unable to update equipment'
            })
        }

            logAudit(request.user?.id, 'ASSET ASSIGNMENT / UPDATE', `Updated asset ${equipment_type} (${asset_tag}); condition ${status}`)
            // CP117: a real status change opens / reuses / completes the Maintenance record (only when the item existed before this save).
            const sync = previousStatus === null ? (done => done({ action: 'none' })) : (done => syncAndAudit(request, { equipmentId: normalizedId, before: previousStatus, after: String(status).trim(), note: condition_note, label: `${equipment_type} (${String(asset_tag).trim()})` }, done))
            return sync(maintenance => response.status(200).json({
                message:'Update Successful',
                equipment:{
                    id,
                    equipment_type,
                    laboratory_id,
                    computer_id: computer_id ||null,
                    asset_tag,
                    serial_number,
                    brand: brand ||null,
                    model: model||null,
                    status,
                    condition_note: condition_note || null

                },
                maintenance
            }))
    }
    )
    })
    })
    }


    const equipmentSql ='SELECT *FROM equipment WHERE id =?'
    db.query(equipmentSql,[normalizedId],(equipmentError,equipmentResults)=>{
        if(equipmentError){
            return response.status(500).json({
                message:'Unable to check the equipment'
            })
        }
        if(equipmentResults.length ===0){
            return response.status(404).json({
                message:'Equipment not found'
            })
        }
            const laboratorySql ='SELECT * FROM laboratories WHERE ID =?'
            db.query(laboratorySql,[normalizedLaboratoryId],(error, laboratoryResults)=>{
            if(error){
                return response.status(500).json({
                    message:'Unable to check laboratory'
                })

            }
            if(laboratoryResults.length===0){
                return response.status(404).json({
                    message: 'Laboratory not found'
                })
            }
            if (normalizedComputerId) {
            const computerSql =
                'SELECT * FROM computers WHERE id = ?'

            db.query(computerSql,[normalizedComputerId],(computerError, computerResults) => {
                if (computerError) {
                return response.status(500).json({
                    message: 'Unable to check computer'
                })
                }
                if (computerResults.length === 0) {
                return response.status(404).json({
                    message: 'Computer not found'
                })
                }
                const computer = computerResults[0]

                if (
                Number(computer.laboratory_id) !== Number(laboratory_id)
                ) {
                return response.status(400).json({
                    message: 'Selected computer does not belong to this laboratory'
                })
                }
                performUpdate()

                }
            )
            }
            else{
                performUpdate()
            }
    })
    })


}

function deleteEquipment(request, response){
    const id=positiveInteger(request.params.id)
    if (!id) return response.status(400).json({ message: 'Invalid equipment ID.' })

    const sql ='DELETE FROM equipment WHERE id =?'
    db.query(sql,[id],(error,results)=>{
        if(error){
            return response.status(500).json({
                message: 'Unable to delete equipment'
            })
        }
        if (results.affectedRows===0){
            return response.status(404).json({
                message:'Equipment not found'
            })
        }
        logAudit(request.user?.id, 'ASSET ASSIGNMENT / UPDATE', `Deleted asset record #${id}`)
        return response.status(200).json({
            message:'Equipment deleted successful'
        })

    })
}
module.exports = {getEquipment,createEquipment,updateEquipment,deleteEquipment}