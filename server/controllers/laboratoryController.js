const db = require ('../database/db.js')
const { validateLaboratoryInput } = require('../utils/laboratoryValidation.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')
function createLaboratory(request, response) {

    const {
        laboratory_name,
        capacity,
        status,
        available_from,
        available_until,
        booking_interval,
        available_date_from,
        available_date_until,
        unavailable_from,
        unavailable_until,
        used_from,
        used_until,
        reason
    } = request.body

    const validation = validateLaboratoryInput(request.body)
    if (validation.error) return response.status(400).json({ message: validation.error })

    const dateRange = validation.values.status === 'OPEN' ? [available_date_from, available_date_until] : validation.values.status === 'UNAVAILABLE' ? [unavailable_from, unavailable_until] : [used_from, used_until]
    if (dateRange[0] && dateRange[1] && dateRange[0] > dateRange[1]) return response.status(400).json({ message: 'The ending date must be on or after the starting date.' })

    if (available_from && available_until) {
        if (available_from >= available_until) {
            return response.status(400).json({
                message: 'Available until must be later than available from'
            })
        }
    }

    const sql = `
        INSERT INTO laboratories
        (
            laboratory_name,
            capacity,
            status,
            available_from,
            available_until,
            booking_interval,
            available_date_from,
            available_date_until,
            unavailable_from,
            unavailable_until,
            used_from,
            used_until,
            reason,
            status_other
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const values = [
        validation.values.laboratory_name, validation.values.capacity, validation.values.status, validation.values.available_from || RESERVATION_POLICY.fallbackLabOpeningTime, validation.values.available_until || RESERVATION_POLICY.fallbackLabClosingTime, validation.values.booking_interval,
        validation.values.status === 'OPEN' ? (available_date_from || null) : null,
        validation.values.status === 'OPEN' ? (available_date_until || null) : null,
        validation.values.status === 'UNAVAILABLE' ? (unavailable_from || null) : null,
        validation.values.status === 'UNAVAILABLE' ? (unavailable_until || null) : null,
        validation.values.status === 'USED' ? (used_from || null) : null,
        validation.values.status === 'USED' ? (used_until || null) : null,
        validation.values.reason,
        validation.values.status_other
    ]

    db.query(
        sql,
        values,
        (error, results) => {

            if (error) {
                if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'A laboratory with this name already exists.' })
                console.error('Unable to create laboratory:', error.message)
                return response.status(500).json({ message: 'Unable to create laboratory. Please try again later.' })
            }

            return response.status(201).json({
                message: 'Laboratory created successfully',
                laboratory: {
                    id: results.insertId,
                    laboratory_name: validation.values.laboratory_name,
                    capacity: validation.values.capacity,
                    status: validation.values.status,
                    available_from: validation.values.available_from || RESERVATION_POLICY.fallbackLabOpeningTime,
                    available_until: validation.values.available_until || RESERVATION_POLICY.fallbackLabClosingTime,
                    booking_interval: validation.values.booking_interval,
                    status_other: validation.values.status_other,
                    available_date_from: values[6], available_date_until: values[7], unavailable_from: values[8], unavailable_until: values[9], used_from: values[10], used_until: values[11], reason: values[12]
                }
            })
        }
    )
}
function getLaboratories(request,response){
    db.query('SELECT * FROM laboratories', (error,results)=>{
        if(error){
            console.error('Retrieve laboratories error:',
                 error.message)

            return response.status(500).json({
                message: ' Unable to retrieve laboratories'
            })
        }
        return response.status(200).json({
            laboratories:results
        })

    })
    

}
function updateLaboratory(request, response) {

    const { id } = request.params

    const {
        laboratory_name,
        capacity,
        status,
        available_from,
        available_until,
        booking_interval,
        available_date_from,
        available_date_until,
        unavailable_from,
        unavailable_until,
        used_from,
        used_until,
        reason
    } = request.body

    const validation = validateLaboratoryInput(request.body)
    if (validation.error) return response.status(400).json({ message: validation.error })

    const dateRange = validation.values.status === 'OPEN' ? [available_date_from, available_date_until] : validation.values.status === 'UNAVAILABLE' ? [unavailable_from, unavailable_until] : [used_from, used_until]
    if (dateRange[0] && dateRange[1] && dateRange[0] > dateRange[1]) return response.status(400).json({ message: 'The ending date must be on or after the starting date.' })

    if (available_from && available_until) {
        if (available_from >= available_until) {
            return response.status(400).json({
                message: 'Available until must be later than available from'
            })
        }
    }
    const sql = `
        UPDATE laboratories
        SET laboratory_name = ?,
            capacity = ?,
            status = ?,
            available_from = ?,
            available_until = ?,
            booking_interval = ?,
            available_date_from = ?,
            available_date_until = ?,
            unavailable_from = ?,
            unavailable_until = ?,
            used_from = ?,
            used_until = ?,
            reason = ?,
            status_other = ?
        WHERE id = ?
    `
    const values = [
        validation.values.laboratory_name, validation.values.capacity, validation.values.status, validation.values.available_from || RESERVATION_POLICY.fallbackLabOpeningTime, validation.values.available_until || RESERVATION_POLICY.fallbackLabClosingTime, validation.values.booking_interval,
        validation.values.status === 'OPEN' ? (available_date_from || null) : null,
        validation.values.status === 'OPEN' ? (available_date_until || null) : null,
        validation.values.status === 'UNAVAILABLE' ? (unavailable_from || null) : null,
        validation.values.status === 'UNAVAILABLE' ? (unavailable_until || null) : null,
        validation.values.status === 'USED' ? (used_from || null) : null,
        validation.values.status === 'USED' ? (used_until || null) : null,
        validation.values.reason,
        validation.values.status_other,
        id
    ]

    db.query(sql, values, (error, results) => {

        if (error) {
            if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'A laboratory with this name already exists.' })
            console.error('Update laboratory error:', error.message)
            return response.status(500).json({ message: 'Unable to update laboratory. Please try again later.' })
        }

        if (results.affectedRows === 0) {
            return response.status(404).json({
                message: 'Laboratory not found'
            })
        }

        return response.status(200).json({
            message: 'Laboratory successfully updated',
            laboratory: {
                id,
                laboratory_name: validation.values.laboratory_name,
                capacity: validation.values.capacity,
                status: validation.values.status,
                available_from: validation.values.available_from || RESERVATION_POLICY.fallbackLabOpeningTime,
                available_until: validation.values.available_until || RESERVATION_POLICY.fallbackLabClosingTime,
                booking_interval: validation.values.booking_interval,
                status_other: validation.values.status_other,
                available_date_from: values[6], available_date_until: values[7], unavailable_from: values[8], unavailable_until: values[9], used_from: values[10], used_until: values[11], reason: values[12]
            }
        })
    })
}

function deleteLaboratory(request, response){
    const {id} = request.params
    db.query('DELETE FROM laboratories WHERE id =?',
        [id],(error,results)=>{
            if (error){
                console.error('Delete laboratory error:', error.message)
                return response.status(500).json({
                    message:'Unable to delete laboratory, Try again later'
                })
            }
            if (results.affectedRows===0){
                return response.status(404).json({
                    message:'laboratory not found'
                })
            }
            return response.status(200).json({
                message:'Laboratory successfully deleted'
            })

    })
}


module.exports = {createLaboratory, getLaboratories, updateLaboratory, deleteLaboratory}
