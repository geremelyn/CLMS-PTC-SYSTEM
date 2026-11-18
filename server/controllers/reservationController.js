const RESERVATION_POLICY = require('../config/reservationPolicy.js')
const { checkReservableDate, checkReservableDateCb, poolQuery } = require('../utils/holidayService.js')
const holidayDates = require('../utils/philippineHolidays.js')
const { resolvePeriod, computePeriodAvailability } = require('../config/reservationPeriods.js')
const RESERVATION_TIME = require('../config/reservationTime.js')
const { isAutoCancelledNote, RESTORE_BLOCKED_NOTE_PREFIX } = require('../utils/pendingReservationExpiry.js')

// Statuses that occupy a laboratory slot. COMPLETED is included so a finished booking still blocks its slot.
const BLOCKING_STATUS_SQL = [...new Set([...RESERVATION_POLICY.conflictStatuses, 'COMPLETED'])].map(v => `'${v}'`).join(',')
// CP105A (Sir JC): a new request is NOT rejected just because an overlapping request is still PENDING (same or another teacher).
// Only decided/active reservations (APPROVED, COMPLETED, ...) block a new request. Approval-time conflict checks are unchanged (CP105B).
// CP165: the blocking set for NEW requests is fixed, not derived from the CLMS_CONFLICT_STATUSES environment setting: ONLY Approved and
// Completed reservations block a new request. PENDING (and DECLINED / CANCELLED) never do, whatever the environment says.
const NEW_REQUEST_BLOCKING_STATUSES = Object.freeze(['APPROVED', 'COMPLETED'])
const NEW_REQUEST_BLOCKING_SQL = NEW_REQUEST_BLOCKING_STATUSES.map(v => `'${v}'`).join(',')

// Load database-backed modules only when a handler executes, so pure date-rule helpers
// can be unit-tested in environments without a configured database driver.
function getDb() { return require('../database/db.js') }
function logAudit(...args) { return require('../utils/auditLogger.js').logAudit(...args) }

function getManilaDateString(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
}

function getManilaTimeString(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.hour}:${values.minute}:${values.second}`
}

function getManilaMinutes(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return Number(values.hour) * 60 + Number(values.minute)
}


function getReservationSession(startTime, endTime) {
    // Time sanity only: valid HH:MM times and end later than start. There are NO fixed morning/afternoon sessions.
    const start = String(startTime || '').slice(0, 5)
    const end = String(endTime || '').slice(0, 5)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
        return { valid: false, message: 'End time must be later than a valid start time.' }
    }
    return { valid: true, message: '' }
}

// Real overlap test (half-open): two reservations conflict only when their time ranges actually intersect.
// Back-to-back bookings (one ends 10:00, next starts 10:00) do NOT conflict.
const OVERLAP_SQL = 'start_time < ? AND end_time > ?'
const toSqlTime = value => { const t = String(value || '').slice(0, 8); return t.length === 5 ? `${t}:00` : t }
function overlapMessage(row) { return row && row.start_time ? `an existing reservation (${String(row.start_time).slice(0, 5)}–${String(row.end_time).slice(0, 5)})` : 'an existing reservation' }

// Single source of truth for a requested time window. Custom start/end times are allowed; the only limits are
// (1) valid 24-hour HH:MM[:SS] strings, (2) end later than start, (3) inside THIS laboratory's configured
// available_from/available_until (data-driven, no fixed schedule). There is no morning/afternoon or cross-noon rule.
function validateReservationWindow(startTime, endTime, labFrom, labUntil) {
    const pattern = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/
    if (typeof startTime !== 'string' || typeof endTime !== 'string' || !pattern.test(startTime) || !pattern.test(endTime)) {
        return { ok: false, message: 'Please enter valid start and end times.' }
    }
    const session = getReservationSession(startTime, endTime)
    if (!session.valid) return { ok: false, message: session.message }
    const from = String(labFrom || RESERVATION_POLICY.fallbackLabOpeningTime).slice(0, 5)
    const until = String(labUntil || RESERVATION_POLICY.fallbackLabClosingTime).slice(0, 5)
    if (startTime.slice(0, 5) < from || endTime.slice(0, 5) > until) {
        return { ok: false, message: `Reservation must be within this laboratory's available hours (${from} - ${until}). Choose a time inside that window, or ask MIS to adjust the laboratory's opening/closing times.` }
    }
    return { ok: true }
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isSundayDateString(value) {
    if (!isValidDateString(value)) return false
    return new Date(`${value}T00:00:00Z`).getUTCDay() === 0
}

function isTimeAlignedToInterval(startTime, endTime, openingTime, intervalMinutes) {
    const parse = value => { const match = String(value || '').slice(0, 5).match(/^([01]\d|2[0-3]):([0-5]\d)$/); return match ? Number(match[1]) * 60 + Number(match[2]) : null }
    const start = parse(startTime), end = parse(endTime), opening = parse(openingTime)
    return Number.isSafeInteger(intervalMinutes) && intervalMinutes > 0 && start != null && end != null && opening != null && start >= opening && end > start && (start - opening) % intervalMinutes === 0 && (end - opening) % intervalMinutes === 0
}

function canUndoReservationDecision(status, decidedAt, secondsSinceDecision, windowSeconds = Infinity) { // no time limit: a manual decision stays undoable until the reservation changes again
    return ['APPROVED', 'DECLINED'].includes(String(status || '').toUpperCase()) && Boolean(decidedAt) && secondsSinceDecision !== null && secondsSinceDecision !== undefined && String(secondsSinceDecision).trim() !== '' && Number.isFinite(Number(secondsSinceDecision)) && Number(secondsSinceDecision) >= 0 && Number(secondsSinceDecision) <= windowSeconds
}

// =========================================================
// GET ALL RESERVATIONS
// =========================================================

function getReservations(request, response) {

    const completeSql = `
        UPDATE reservations
        SET status = 'COMPLETED'
        WHERE status = 'APPROVED'
        AND (reservation_date < ? OR (reservation_date = ? AND end_time <= ?))
    `

    const manilaToday = getManilaDateString()
    const manilaTime = getManilaTimeString()
    // CP106: pending reservations are never changed automatically; only a manual MIS decision (or CP105B's overlap cancellation) moves them.
      getDb().query(completeSql, [manilaToday, manilaToday, manilaTime], (completeError) => {

        if (completeError) {

            console.error(
                'Unable to update reservation status:',
                completeError
            )

            return response.status(500).json({
                message: 'Unable to update reservation status'
            })
        }

        let sql = `
            SELECT
                reservations.*,
                DATE_FORMAT(reservations.reservation_date, '%Y-%m-%d') AS formatted_reservation_date,
                laboratories.laboratory_name,
                laboratories.status AS laboratory_status,
                users.full_name AS reserved_by_name,
                users.username AS reserved_by_username,
                users.role AS reserved_by_role,
                users.role_other AS reserved_by_role_other,
                users.program AS reserved_by_program
            FROM reservations
            LEFT JOIN laboratories ON reservations.laboratory_id = laboratories.id
            LEFT JOIN users ON reservations.reserved_by = users.id
        `
        const params = []

        // MIS can monitor all reservations. Dean can view approved reservations.
        // Teacher can view only their own reservations. Inventory can view the
        // approved schedule but has no reservation creation/cancellation rights.
        // Custom-role (Others) accounts behave exactly like Teachers here: they only ever see their own reservations.
        if (request.user?.role === 'Teacher' || request.user?.role === 'Others') {
            sql += ' WHERE reservations.reserved_by = ?'
            params.push(request.user.id)
        } else if (request.user?.role === 'Dean') {
            // Dean may review the approved/completed schedule, while My Reservations
            // must also retain the Dean's own cancelled history.
            sql += ` WHERE reservations.status IN ('APPROVED','COMPLETED') OR reservations.reserved_by = ?`
            params.push(request.user.id)
        } else if (request.user?.role === 'Inventory Staff') {
            // Monitoring view: only reservations actually submitted for approval. Reservations auto-declined at
            // creation (cutoff / time overlap) never entered the approval flow and are excluded.
            sql += ` WHERE reservations.status IN ('PENDING','APPROVED','COMPLETED','DECLINED')
                AND NOT (reservations.status = 'DECLINED' AND (reservations.decision_note LIKE 'Reservation requests must be submitted more than%' OR reservations.decision_note LIKE 'The % session already has a reservation%' OR reservations.decision_note LIKE 'The requested time overlaps%'))`
        }

        sql += ` ORDER BY created_at DESC, reservation_date DESC, start_time DESC`

        getDb().query(sql, params, (error, results) => {

            if (error) {

                console.error(
                    'Unable to load reservations:',
                    error
                )

                return response.status(500).json({
                    message: 'Unable to load reservations'
                })
            }

            return response.status(200).json({
                reservations: results
            })
        })
      })
}


// =========================================================
// CREATE RESERVATION
// =========================================================

function createReservation(request, response) {
    const db = require('../utils/safeDb.js').guardDb(getDb(), response, 'reservation creation')

    const {
        laboratory_id,
        reservation_date,
        period,
        start_time: bodyStart,
        end_time: bodyEnd,
        purpose,
        subject_name,
        professor_name
    } = request.body
    const reserved_by = request.user?.id
    const requesterRole = request.user?.role
    // Flexible booking: the client sends start_time/end_time (30-minute increments, inside operating hours; rules live in
    // config/reservationTime.js). Legacy clients that still send only a Morning/Afternoon `period` keep working.
    const legacyPeriod = (bodyStart === undefined && bodyEnd === undefined) ? resolvePeriod(period) : null
    const timeCheck = legacyPeriod ? RESERVATION_TIME.validateTimeRange(legacyPeriod.start, legacyPeriod.end) : RESERVATION_TIME.validateTimeRange(bodyStart, bodyEnd)
    const start_time = timeCheck.ok ? timeCheck.start : undefined
    const end_time = timeCheck.ok ? timeCheck.end : undefined
    const periodDef = { key: legacyPeriod ? legacyPeriod.key : 'CUSTOM', label: 'Requested time', display: timeCheck.ok ? `${RESERVATION_TIME.display(start_time)} – ${RESERVATION_TIME.display(end_time)}` : '' }
    const normalizedPurpose = purpose?.trim() || (requesterRole === 'MIS' ? 'System Reservation' : '')
    const normalizedSubjectName = subject_name?.trim() || (requesterRole === 'MIS' ? 'System Reservation' : '')
    const normalizedProfessorName = professor_name?.trim() || (requesterRole === 'MIS' ? 'MIS' : '')

    if (
        !laboratory_id ||
        reserved_by === undefined ||
        reserved_by === null ||
        !reservation_date ||
        (!purpose?.trim() && request.user?.role !== 'MIS') ||
        (!subject_name?.trim() && requesterRole !== 'MIS') || (!professor_name?.trim() && requesterRole !== 'MIS')
    ) {

        return response.status(400).json({
            message: 'Please complete laboratory, date, start time, and end time. Teachers must also supply subject, professor, and purpose.'
        })
    }

    // Column sizes in the reservations table (purpose 255, subject_name 150, professor_name 150). MySQL/MariaDB strict mode
    // rejects longer values with ER_DATA_TOO_LONG (a generic 500) and non-strict mode would silently truncate them.
    if (normalizedPurpose.length > 255) return response.status(400).json({ message: 'Purpose must be 255 characters or fewer.' })
    if (normalizedSubjectName.length > 150) return response.status(400).json({ message: 'Subject name must be 150 characters or fewer.' })
    if (normalizedProfessorName.length > 150) return response.status(400).json({ message: 'Professor name must be 150 characters or fewer.' })

    if (!isValidDateString(String(reservation_date))) {
        return response.status(400).json({ message: 'Please enter a valid reservation date.' })
    }
    if (RESERVATION_POLICY.blockSunday && isSundayDateString(String(reservation_date))) {
        return response.status(400).json({ message: 'Sunday reservations are not allowed. Please choose another date.' })
    }

    if (!timeCheck.ok) {
        return response.status(400).json({ message: timeCheck.message })
    }


    // ---------------------------------------------------------
    // CHECK USER
    // ---------------------------------------------------------

    const userSql = `
        SELECT id, full_name, role, status
        FROM users
        WHERE id = ?
    `

    // Philippine holidays: regular holidays and special non-working days are closed; Special WORKING days stay bookable.
    // The check runs before any other work; a table read error falls back to the built-in baseline (never to "open").
    checkReservableDateCb(db, String(reservation_date), holidayCheck => {
    if (!holidayCheck.ok) return response.status(400).json({ message: holidayCheck.message, code: holidayCheck.code === 'HOLIDAY' ? 'HOLIDAY' : undefined, holiday: holidayCheck.holiday ? { name: holidayCheck.holiday.name, holiday_type: holidayCheck.holiday.holiday_type } : undefined })
    db.query(
        userSql,
        [reserved_by],
        (userError, userResults) => {

            if (userError) {

                console.error(
                    'Unable to check user:',
                    userError
                )

                return response.status(500).json({
                    message: 'Unable to verify user.'
                })
            }

            if (userResults.length === 0) {
                return response.status(404).json({ message: 'User not found.' })
            }

            const user = userResults[0]
            if (user.status === 'INACTIVE') {
                return response.status(403).json({ message: 'This account is inactive.' })
            }

            const allowedRoles = [
                'MIS',
                'Dean',
                'Teacher',
                'Others'
            ]

            if (!allowedRoles.includes(user.role)) {

                return response.status(403).json({
                    message:
                        'Your role is not authorized to create laboratory reservations.'
                })
            }


            // -------------------------------------------------
            // CHECK LABORATORY
            // -------------------------------------------------

            const laboratorySql = `
                SELECT *
                FROM laboratories
                WHERE id = ?
            `

            db.query(
                laboratorySql,
                [laboratory_id],
                (
                    laboratoryError,
                    laboratoryResults
                ) => {

                    if (laboratoryError) {

                        console.error(
                            'Unable to check laboratory:',
                            laboratoryError
                        )

                        return response.status(500).json({
                            message:
                                'Unable to check laboratory.'
                        })
                    }

                    if (
                        laboratoryResults.length === 0
                    ) {

                        return response.status(404).json({
                            message:
                                'Laboratory not found.'
                        })
                    }

                    const laboratory =
                        laboratoryResults[0]


                    // -------------------------------------------------
                    // ONLY OPEN LABS MAY BE RESERVED
                    // -------------------------------------------------

                    if (
                        String(laboratory.status).toUpperCase() !== 'OPEN'
                    ) {
                        return response.status(400).json({
                            message: 'Only OPEN laboratories can be reserved.'
                        })
                    }

                    // Operating hours (07:00-21:00) and 30-minute increments were validated above from config/reservationTime.js.
                    const requestedStart = String(start_time).slice(0, 5)
                    const requestedEnd = String(end_time).slice(0, 5)

                    // Reservation dates are interpreted in the college's local timezone,
                    // avoiding UTC date rollover for users in the Philippines.
                    const todaySql = getManilaDateString()
                    if (reservation_date < todaySql) {
                        return response.status(400).json({
                            message: 'Reservation date cannot be in the past.'
                        })
                    }

                    // Do not allow a same-day reservation whose start time
                    // has already passed. This prevents a newly created test
                    // reservation from being immediately auto-completed when
                    // MIS refreshes its reservation monitor.
                    if (reservation_date === todaySql) {
                        const currentMinutes = getManilaMinutes()
                        const [requestedHour, requestedMinute] = requestedStart.split(':').map(Number)
                        const requestedMinutes = requestedHour * 60 + requestedMinute
                        if (requestedMinutes <= currentMinutes) {
                            return response.status(400).json({
                                code: 'PERIOD_STARTED',
                                message: 'That start time has already passed today. Please choose a later time or another date.'
                            })
                        }
                    }

                    // Serialize reservation creation per laboratory. The laboratory row
                    // remains locked until the conflict check and approved INSERT commit.
                    // Re-check status and hours under the same lock to avoid a race with
                    // a concurrent laboratory status/schedule update.
                    db.getConnection((connectionError, connection) => {
                        if (connectionError) {
                            console.error('Unable to start reservation transaction:', connectionError)
                            return response.status(503).json({ message: 'Unable to reserve this laboratory right now. Please try again.' })
                        }

                        const release = () => connection.release()
                        const rollbackResponse = (statusCode, payload, error = null) => {
                            connection.rollback(rollbackError => {
                                release()
                                if (error) console.error('Reservation transaction failed:', error)
                                if (rollbackError) console.error('Reservation rollback failed:', rollbackError)
                                if (!response.headersSent) response.status(statusCode).json(payload)
                            })
                        }

                        connection.beginTransaction(transactionError => {
                            if (transactionError) {
                                release()
                                console.error('Unable to begin reservation transaction:', transactionError)
                                return response.status(500).json({ message: 'Unable to start reservation transaction.' })
                            }

                            connection.query(
                                'SELECT id, status, available_from, available_until, booking_interval FROM laboratories WHERE id = ? FOR UPDATE',
                                [laboratory_id],
                                (lockError, lockedLaboratories) => {
                                    if (lockError) return rollbackResponse(500, { message: 'Unable to lock laboratory schedule.' }, lockError)
                                    if (!lockedLaboratories.length) return rollbackResponse(404, { message: 'Laboratory not found.' })

                                    const lockedLab = lockedLaboratories[0]
                                    if (String(lockedLab.status).toUpperCase() !== 'OPEN') {
                                        return rollbackResponse(400, { message: 'Only OPEN laboratories can be reserved.' })
                                    }

                                    const conflictSql = `SELECT id, start_time, end_time FROM reservations
                                        WHERE laboratory_id = ? AND reservation_date = ?
                                        AND status IN (${NEW_REQUEST_BLOCKING_SQL})
                                        AND ${OVERLAP_SQL}
                                        LIMIT 1 FOR UPDATE`
                                    connection.query(conflictSql, [laboratory_id, reservation_date, toSqlTime(requestedEnd), toSqlTime(requestedStart)], (conflictError, conflicts) => {
                                        if (conflictError) return rollbackResponse(500, { message: 'Unable to check schedule.' }, conflictError)
                                        // Double-booking protection: the slot was (re)checked under the laboratory row lock.
                                        // An occupied slot is rejected outright (nothing is inserted) so the client can refresh availability.
                                        if (conflicts.length) return rollbackResponse(409, { code: 'SLOT_TAKEN', message: `${periodDef.display} overlaps an existing reservation for this laboratory on this date. Please choose a different time or date.` })
                                        // Every valid request is accepted as PENDING, even for tomorrow, and stays PENDING until MIS / authorized MIS Staff
                                        // manually approves or declines it (CP106: no automatic expiry), or an earlier overlapping request is decided first (CP105B).
                                        const initialStatus = 'PENDING'
                                        const decisionNote = null
                                        const values = [laboratory_id, reserved_by, reservation_date, start_time, end_time, normalizedPurpose, normalizedSubjectName, normalizedProfessorName, initialStatus, decisionNote]
                                        connection.query(`INSERT INTO reservations
                                            (laboratory_id, reserved_by, reservation_date, start_time, end_time, purpose, subject_name, professor_name, status, decision_note)
                                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values, (insertError, insertResults) => {
                                            if (insertError) return rollbackResponse(500, { message: 'Unable to create reservation.' }, insertError)
                                            const createdId = insertResults.insertId
                                            connection.commit(commitError => {
                                                if (commitError) {
                                                    return connection.rollback(rollbackError => {
                                                        release()
                                                        console.error('Reservation commit failed:', commitError)
                                                        if (rollbackError) console.error('Reservation rollback failed:', rollbackError)
                                                        if (!response.headersSent) response.status(500).json({ message: 'Unable to finalize reservation.' })
                                                    })
                                                }
                                                release()
                                                logAudit(reserved_by, 'RESERVATION CREATION', `Reservation #${createdId} ${initialStatus.toLowerCase()}: ${reservation_date} ${periodDef.label} ${start_time}-${end_time}`)
                                                response.status(201).json({
                                                    period: periodDef.key,
                                                    message: 'Reservation submitted and is pending approval.',
                                                    auto_declined: initialStatus === 'DECLINED',
                                                    reservation: { id: createdId, laboratory_id, reserved_by, reservation_date, start_time, end_time, purpose: normalizedPurpose, subject_name: normalizedSubjectName, professor_name: normalizedProfessorName, status: initialStatus, decision_note: decisionNote }
                                                })
                                            })
                                        })
                                    })
                                }
                            )
                        })
                    })
                }
            )
        }
    )
    })
}




// =========================================================
// PERIOD AVAILABILITY (Morning / Afternoon) for one laboratory + date
// =========================================================
async function getPeriodAvailability(request, response) {
    const laboratoryId = Number(request.query?.laboratory_id)
    const date = String(request.query?.date || '')
    if (!Number.isSafeInteger(laboratoryId) || laboratoryId < 1) return response.status(400).json({ message: 'Choose a laboratory.' })
    if (!isValidDateString(date)) return response.status(400).json({ message: 'Please enter a valid reservation date.' })
    const db = getDb()
    const run = (sql, values = []) => new Promise((resolve, reject) => db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    try {
        const labs = await run('SELECT id, status, available_from, available_until FROM laboratories WHERE id = ?', [laboratoryId])
        if (!labs.length) return response.status(404).json({ message: 'Laboratory not found.' })
        const lab = labs[0]
        const today = getManilaDateString()
        let closedReason = null, closedMessage = null
        if (String(lab.status).toUpperCase() !== 'OPEN') { closedReason = 'LAB_NOT_OPEN'; closedMessage = 'Only OPEN laboratories can be reserved.' }
        else if (date < today) { closedReason = 'PAST_DATE'; closedMessage = 'Reservation date cannot be in the past.' }
        else if (RESERVATION_POLICY.blockSunday && isSundayDateString(date)) { closedReason = 'SUNDAY'; closedMessage = 'Sunday reservations are not allowed. Please choose another date.' }
        else {
            const closed = await checkReservableDate(run, date)
            if (!closed.ok) { closedReason = 'HOLIDAY'; closedMessage = closed.message }
        }
        const blocking = closedReason ? [] : await run(`SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND status IN (${NEW_REQUEST_BLOCKING_SQL})`, [laboratoryId, date])
        const periods = computePeriodAvailability({
            blocking,
            labFrom: lab.available_from || RESERVATION_POLICY.fallbackLabOpeningTime,
            labUntil: lab.available_until || RESERVATION_POLICY.fallbackLabClosingTime,
            date, today, nowMinutes: getManilaMinutes(), closedReason
        })
        const anyAvailable = periods.some(p => p.available)
        const message = closedMessage || (anyAvailable ? '' : (periods.every(p => p.reason === 'OCCUPIED') ? 'Both Morning and Afternoon are already reserved for this laboratory on this date. Please choose another date or laboratory.' : 'No reservation period is available for this laboratory on this date. Please choose another date or laboratory.'))
        return response.json({ laboratory_id: laboratoryId, date, periods, any_available: anyAvailable, message })
    } catch (error) {
        console.error('Unable to load period availability:', error.code || error.message)
        return response.status(500).json({ message: 'Unable to check availability.' })
    }
}

// =========================================================
// MIS / MIS STAFF APPROVAL
// =========================================================
async function decideReservation(request, response) {
    const id = Number(request.params.id)
    const decision = String(request.body?.decision || '').toUpperCase()
    const note = String(request.body?.decision_note || '').trim()
    const user = request.user
    if (!Number.isSafeInteger(id) || id <= 0 || !['APPROVED', 'DECLINED'].includes(decision)) return response.status(400).json({ message: 'Choose approve or decline for a valid reservation.' })
    if (decision === 'DECLINED' && !note) return response.status(400).json({ message: 'Provide a reason when declining a reservation.' })
    if (note.length > 255) return response.status(400).json({ message: 'Decision note must be 255 characters or fewer.' })
    if (!user || !['MIS', 'Inventory Staff'].includes(user.role)) return response.status(403).json({ message: 'Only MIS or Inventory Staff may decide reservations.' })
    const db = getDb()
    let connection
    let transaction = false
    const run = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, conn) => error ? reject(error) : resolve(conn)))
        await new Promise((resolve, reject) => connection.beginTransaction(error => error ? reject(error) : resolve()))
        transaction = true
        const initialRows = await run('SELECT id, laboratory_id FROM reservations WHERE id = ?', [id])
        if (!initialRows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        // Use the same laboratory-before-reservation lock order as create and undo paths.
        const labs = await run('SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [initialRows[0].laboratory_id])
        if (!labs.length) throw Object.assign(new Error('Laboratory not found.'), { httpStatus: 404 })
        const rows = await run('SELECT id, laboratory_id, reservation_date, start_time, end_time, status, created_at FROM reservations WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const reservation = rows[0]
        if (reservation.status !== 'PENDING') throw Object.assign(new Error('Only pending reservations can be decided.'), { httpStatus: 409 })
        // CP105C (Sir JC, first-come first-served): the earliest submitted overlapping PENDING request must be decided first.
        // "Earlier" = smaller created_at, with the smaller id as the tie-breaker. Nothing is changed when a decision is refused.
        const earlier = await run(`SELECT id FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status = 'PENDING' AND ${OVERLAP_SQL} AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE`, [reservation.laboratory_id, reservation.reservation_date, id, toSqlTime(reservation.end_time), toSqlTime(reservation.start_time), reservation.created_at, reservation.created_at, id])
        if (earlier.length) throw Object.assign(new Error(`An earlier overlapping reservation (#${earlier[0].id}) was submitted first for this laboratory, date and time. Approve or decline that request first.`), { httpStatus: 409, code: 'EARLIER_REQUEST_FIRST' })
        if (decision === 'APPROVED') {
            // A reservation flagged because its date became a holiday may be declined, but not approved.
            const dateText = reservation.reservation_date instanceof Date ? holidayDates.manilaDateString(reservation.reservation_date) : String(reservation.reservation_date).slice(0, 10)
            const closed = await checkReservableDate((sql, values = []) => run(sql, values), dateText)
            if (!closed.ok && closed.code === 'HOLIDAY') throw Object.assign(new Error(`This date is closed (${closed.holiday.name}). Decline or reschedule the reservation instead of approving it.`), { httpStatus: 409 })
            const session = getReservationSession(String(reservation.start_time).slice(0, 5), String(reservation.end_time).slice(0, 5))
            if (!session.valid) throw Object.assign(new Error(session.message), { httpStatus: 409 })
            const conflicts = await run(`SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status IN (${NEW_REQUEST_BLOCKING_SQL}) AND ${OVERLAP_SQL} LIMIT 1`, [reservation.laboratory_id, reservation.reservation_date, id, toSqlTime(reservation.end_time), toSqlTime(reservation.start_time)])
            if (conflicts.length) throw Object.assign(new Error(`Cannot approve: the time overlaps ${overlapMessage(conflicts[0])} for this laboratory and date.`), { httpStatus: 409 })
        }
        const result = await run("UPDATE reservations SET status = ?, decision_note = ?, decided_by = ?, decided_at = NOW() WHERE id = ? AND status = 'PENDING'", [decision, note || null, user.id, id])
        if (!result.affectedRows) throw Object.assign(new Error('Reservation was already processed.'), { httpStatus: 409 })
        // CP105B (Sir JC, first-come first-served): the decided reservation keeps its APPROVED/DECLINED status and every OTHER still-PENDING
        // reservation that overlaps it (same laboratory + date, real overlap; back-to-back is not an overlap) is CANCELLED in the same transaction.
        // The laboratory row is already locked FOR UPDATE above (same lock order as create/cancel/undo), so no new request can slip in meanwhile.
        const losers = await run(`SELECT id FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status = 'PENDING' AND ${OVERLAP_SQL} FOR UPDATE`, [reservation.laboratory_id, reservation.reservation_date, id, toSqlTime(reservation.end_time), toSqlTime(reservation.start_time)])
        const autoCancelledIds = losers.map(row => row.id)
        if (autoCancelledIds.length) {
            const cancelNote = `${RESTORE_BLOCKED_NOTE_PREFIX} an overlapping request (#${id}) for this laboratory, date and time was ${decision.toLowerCase()} first.`
            const cancelled = await run(`UPDATE reservations SET status = 'CANCELLED', cancellation_note = ?, cancelled_at = NOW(), cancelled_by = ? WHERE id IN (${autoCancelledIds.map(() => '?').join(',')}) AND status = 'PENDING'`, [cancelNote, user.id, ...autoCancelledIds])
            if (cancelled.affectedRows !== autoCancelledIds.length) throw Object.assign(new Error('Overlapping requests changed during the decision. Refresh and retry.'), { httpStatus: 409 })
        }
        await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve()))
        transaction = false
        logAudit(user.id, `RESERVATION ${decision}`, `Reservation #${id} ${decision.toLowerCase()}${note ? `: ${note}` : ''}`)
        for (const cancelledId of autoCancelledIds) logAudit(user.id, 'RESERVATION AUTO-CANCELLED', `Reservation #${cancelledId} automatically cancelled because overlapping reservation #${id} was ${decision.toLowerCase()} first.`)
        return response.json({ message: `Reservation ${decision.toLowerCase()} successfully.`, auto_cancelled_ids: autoCancelledIds })
    } catch (error) {
        if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
        console.error('Unable to decide reservation:', error.code || error.message)
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') return response.status(409).json({ message: 'Another reservation update is in progress. Refresh and retry the decision.' })
        return response.status(500).json({ message: 'Unable to update reservation; no changes were saved.' })
    } finally { connection?.release() }
}

// =========================================================
// UNDO AN APPROVAL OR DECLINE
// =========================================================
async function undoDecisionReservation(request, response) {
    const id = Number(request.params.id)
    const user = request.user
    if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid reservation ID.' })
    if (!user || !['MIS', 'Inventory Staff'].includes(user.role)) return response.status(403).json({ message: 'Only MIS or Inventory Staff may undo reservation decisions.' })
    const db = getDb()
    let connection
    let transaction = false
    const run = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, conn) => error ? reject(error) : resolve(conn)))
        await new Promise((resolve, reject) => connection.beginTransaction(error => error ? reject(error) : resolve()))
        transaction = true
        // First discover the lab without locking the reservation. Then lock the lab before
        // locking/re-reading the reservation, matching the create flow's lock order.
        const initialRows = await run('SELECT id, laboratory_id FROM reservations WHERE id = ?', [id])
        if (!initialRows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const labRows = await run('SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [initialRows[0].laboratory_id])
        if (!labRows.length) throw Object.assign(new Error('Laboratory not found; reservation cannot be restored.'), { httpStatus: 409 })
        const rows = await run('SELECT id, laboratory_id, reservation_date, start_time, end_time, status, decided_at, decided_by, TIMESTAMPDIFF(SECOND, decided_at, NOW()) AS seconds_since_decision FROM reservations WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const reservation = rows[0]
        if (!canUndoReservationDecision(reservation.status, reservation.decided_at, reservation.seconds_since_decision) || reservation.decided_by == null) {
            throw Object.assign(new Error('Only a manually approved or declined reservation can have its decision undone.'), { httpStatus: 409 })
        }
        if (reservation.status === 'DECLINED') {
            // Undoing a decline re-opens the booking, so the date must still be bookable (holiday / Sunday rules).
            const dateText = reservation.reservation_date instanceof Date ? holidayDates.manilaDateString(reservation.reservation_date) : String(reservation.reservation_date).slice(0, 10)
            const closedDate = await checkReservableDate((sql, values = []) => run(sql, values), dateText)
            if (!closedDate.ok) throw Object.assign(new Error(`Cannot undo this decline: ${closedDate.message}`), { httpStatus: 409 })
        }
        const session = getReservationSession(String(reservation.start_time).slice(0, 5), String(reservation.end_time).slice(0, 5))
        if (!session.valid) throw Object.assign(new Error('The reservation time is invalid and cannot be restored to pending.'), { httpStatus: 409 })
        const conflicts = await run(`SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status IN (${RESERVATION_POLICY.conflictStatusSql}) AND ${OVERLAP_SQL} LIMIT 1`, [reservation.laboratory_id, reservation.reservation_date, id, toSqlTime(reservation.end_time), toSqlTime(reservation.start_time)])
        if (conflicts.length) throw Object.assign(new Error(`Cannot undo this decision because the time now overlaps ${overlapMessage(conflicts[0])}.`), { httpStatus: 409 })
        const result = await run("UPDATE reservations SET status = 'PENDING', decision_note = NULL, decided_by = NULL, decided_at = NULL WHERE id = ? AND status = ? AND decided_at = ? AND decided_by = ?", [id, reservation.status, reservation.decided_at, reservation.decided_by])
        if (!result.affectedRows) throw Object.assign(new Error('Reservation changed before the undo could be applied.'), { httpStatus: 409 })
        await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve()))
        transaction = false
        logAudit(user.id, 'RESERVATION DECISION UNDONE', `Undo ${reservation.status.toLowerCase()} for reservation #${id}; returned to pending.`)
        return response.json({ message: `Reservation ${reservation.status.toLowerCase()} undone. It is pending approval again.` })
    } catch (error) {
        if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
        console.error('Unable to undo reservation decision:', error.code || error.message)
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') return response.status(409).json({ message: 'Another reservation update is in progress. Refresh and retry the undo.' })
        return response.status(500).json({ message: 'Unable to undo reservation decision; no changes were saved.' })
    } finally { connection?.release() }
}

// =========================================================
// CANCEL RESERVATION
// =========================================================

async function cancelReservation(request, response) {
    const id = Number(request.params.id)
    const note = typeof request.body?.cancellation_note === 'string' ? request.body.cancellation_note.trim() : ''
    const userId = request.user?.id
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ message: 'Invalid reservation ID.' })
    if (userId === undefined || userId === null) return response.status(401).json({ message: 'Authentication required.' })
    if (!note) return response.status(400).json({ message: 'Please provide a cancellation note.' })
    if (note.length > 255) return response.status(400).json({ message: 'Cancellation note must be 255 characters or fewer.' })

    const db = getDb()
    let connection
    let transaction = false
    const run = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    const finishTransaction = method => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, conn) => error ? reject(error) : resolve(conn)))
        await finishTransaction('beginTransaction')
        transaction = true
        const users = await run('SELECT id, full_name, role, status FROM users WHERE id = ?', [userId])
        if (!users.length) throw Object.assign(new Error('User not found.'), { httpStatus: 404 })
        const user = users[0]
        if (String(user.status).toUpperCase() === 'INACTIVE') throw Object.assign(new Error('This account is inactive.'), { httpStatus: 403 })
        if (!['MIS', 'Dean', 'Teacher', 'Others'].includes(user.role)) throw Object.assign(new Error('Your role is not authorized to cancel reservations.'), { httpStatus: 403 })

        // Lock order is shared with creation, approval, and undo: laboratory before reservation.
        const initialRows = await run('SELECT id, laboratory_id FROM reservations WHERE id = ?', [id])
        if (!initialRows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const labs = await run('SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [initialRows[0].laboratory_id])
        if (!labs.length) throw Object.assign(new Error('Laboratory not found.'), { httpStatus: 409 })
        const rows = await run('SELECT id, laboratory_id, reserved_by, status FROM reservations WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const reservation = rows[0]
        if (reservation.status !== 'APPROVED') throw Object.assign(new Error('This reservation can no longer be cancelled.'), { httpStatus: 409 })
        if (user.role !== 'MIS' && Number(reservation.reserved_by) !== Number(user.id)) throw Object.assign(new Error('You may only cancel your own reservation.'), { httpStatus: 403 })

        const result = await run("UPDATE reservations SET status = 'CANCELLED', cancellation_note = ?, cancelled_at = NOW(), cancelled_by = ? WHERE id = ? AND status = 'APPROVED'", [note, user.id, id])
        if (!result.affectedRows) throw Object.assign(new Error('Reservation changed before cancellation could be applied.'), { httpStatus: 409 })
        await finishTransaction('commit')
        transaction = false
        logAudit(user.id, 'RESERVATION CANCELLATION', `Reservation #${id} cancelled by ${user.role}: ${note}`)
        return response.status(200).json({ message: 'Reservation cancelled successfully.' })
    } catch (error) {
        if (transaction && connection) {
            try { await finishTransaction('rollback') } catch (rollbackError) { console.error('Reservation cancellation rollback failed:', rollbackError.code || rollbackError.message) }
        }
        console.error('Unable to cancel reservation:', error.code || error.message)
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') return response.status(409).json({ message: 'Another reservation update is in progress. Refresh and retry the cancellation.' })
        return response.status(500).json({ message: 'Unable to cancel reservation; no changes were saved.' })
    } finally { connection?.release() }
}


// =========================================================
// COMPLETE RESERVATION
// =========================================================


async function undoCancelReservation(request, response) {
    const id = Number(request.params.id)
    const user = request.user
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ message: 'Invalid reservation ID.' })
    if (!user || user.id === undefined || user.id === null) return response.status(401).json({ message: 'Authentication required.' })
    if (!['MIS', 'Dean', 'Teacher', 'Others'].includes(user.role)) return response.status(403).json({ message: 'Your role cannot undo reservation cancellations.' })

    const db = getDb()
    let connection
    let transaction = false
    const run = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    const finishTransaction = method => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, conn) => error ? reject(error) : resolve(conn)))
        await finishTransaction('beginTransaction')
        transaction = true

        // Match the reservation create/decision lock order: laboratory first, then the row.
        const initialRows = await run('SELECT id, laboratory_id FROM reservations WHERE id = ?', [id])
        if (!initialRows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const labRows = await run('SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [initialRows[0].laboratory_id])
        if (!labRows.length) throw Object.assign(new Error('Laboratory not found; reservation cannot be restored.'), { httpStatus: 409 })
        const rows = await run('SELECT id, laboratory_id, reserved_by, reservation_date, start_time, end_time, status, cancellation_note, cancelled_at, cancelled_by, TIMESTAMPDIFF(SECOND, cancelled_at, NOW()) AS seconds_since_cancel FROM reservations WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const reservation = rows[0]
        if (user.role !== 'MIS' && Number(reservation.reserved_by) !== Number(user.id)) {
            throw Object.assign(new Error('You may only undo cancellation of your own reservation.'), { httpStatus: 403 })
        }
        if (reservation.status !== 'CANCELLED' || !reservation.cancelled_at) {
            throw Object.assign(new Error('This cancellation is no longer eligible for undo.'), { httpStatus: 409 })
        }
        // CP25: an automatic cancellation was never approved, so it must not be restorable to APPROVED.
        if (isAutoCancelledNote(reservation.cancellation_note)) throw Object.assign(new Error('Automatically cancelled reservations cannot be restored. Please submit a new reservation.'), { httpStatus: 409 })
        // Only the person who cancelled may undo it. A Teacher/Dean cancelling an approved reservation must not give MIS an
        // "Undo cancellation"; older rows with no recorded canceller can only be undone by the reservation's owner.
        if (reservation.cancelled_by != null ? Number(reservation.cancelled_by) !== Number(user.id) : user.role === 'MIS') {
            throw Object.assign(new Error('Only the person who cancelled this reservation can undo the cancellation.'), { httpStatus: 403 })
        }
        const age = Number(reservation.seconds_since_cancel)
        if (!Number.isFinite(age) || age < 0) {
            throw Object.assign(new Error('This reservation has no valid cancellation record to undo.'), { httpStatus: 409 })
        }
        // The date may have become a holiday since the cancellation: re-activating the booking would re-open a closed date.
        const dateText = reservation.reservation_date instanceof Date ? holidayDates.manilaDateString(reservation.reservation_date) : String(reservation.reservation_date).slice(0, 10)
        const closedDate = await checkReservableDate((sql, values = []) => run(sql, values), dateText)
        if (!closedDate.ok) throw Object.assign(new Error(`Cannot undo this cancellation: ${closedDate.message}`), { httpStatus: 409 })
        const session = getReservationSession(String(reservation.start_time).slice(0, 5), String(reservation.end_time).slice(0, 5))
        if (!session.valid) throw Object.assign(new Error('Reservation time is invalid; cancellation cannot be undone.'), { httpStatus: 409 })
        const conflicts = await run(`SELECT id, start_time, end_time FROM reservations WHERE laboratory_id = ? AND reservation_date = ? AND id <> ? AND status IN (${RESERVATION_POLICY.conflictStatusSql}) AND ${OVERLAP_SQL} LIMIT 1`, [reservation.laboratory_id, reservation.reservation_date, id, toSqlTime(reservation.end_time), toSqlTime(reservation.start_time)])
        if (conflicts.length) throw Object.assign(new Error(`Cannot undo cancellation because the time now overlaps ${overlapMessage(conflicts[0])}.`), { httpStatus: 409 })

        const result = await run("UPDATE reservations SET status = 'APPROVED', cancellation_note = NULL, cancelled_at = NULL, cancelled_by = NULL WHERE id = ? AND status = 'CANCELLED' AND cancelled_at = ?", [id, reservation.cancelled_at])
        if (!result.affectedRows) throw Object.assign(new Error('Reservation changed before the undo could be applied.'), { httpStatus: 409 })
        await finishTransaction('commit')
        transaction = false
        logAudit(user.id, 'RESERVATION CANCELLATION UNDONE', `Cancellation undone for reservation #${id}`)
        return response.json({ message: 'Cancellation undone. Reservation restored to approved.' })
    } catch (error) {
        if (transaction && connection) {
            try { await finishTransaction('rollback') } catch (rollbackError) { console.error('Reservation cancellation undo rollback failed:', rollbackError.code || rollbackError.message) }
        }
        console.error('Unable to undo reservation cancellation:', error.code || error.message)
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') return response.status(409).json({ message: 'Another reservation update is in progress. Refresh and retry the undo.' })
        return response.status(500).json({ message: 'Unable to undo cancellation; no changes were saved.' })
    } finally { connection?.release() }
}

async function undoCreateReservation(request, response) {
    const id = Number(request.params.id)
    const user = request.user
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ message: 'Invalid reservation ID.' })
    if (!user || user.id === undefined || user.id === null) return response.status(401).json({ message: 'Authentication required.' })
    if (!['MIS', 'Dean', 'Teacher', 'Others'].includes(user.role)) return response.status(403).json({ message: 'Your role cannot undo reservation creation.' })

    const db = getDb()
    let connection
    let transaction = false
    const run = (sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
    const finishTransaction = method => new Promise((resolve, reject) => connection[method](error => error ? reject(error) : resolve()))
    try {
        connection = await new Promise((resolve, reject) => db.getConnection((error, conn) => error ? reject(error) : resolve(conn)))
        await finishTransaction('beginTransaction')
        transaction = true
        const initialRows = await run('SELECT id, laboratory_id FROM reservations WHERE id = ?', [id])
        if (!initialRows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const labs = await run('SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [initialRows[0].laboratory_id])
        if (!labs.length) throw Object.assign(new Error('Laboratory not found; reservation cannot be undone.'), { httpStatus: 409 })
        const rows = await run('SELECT id, reserved_by, status, created_at, decided_by, decided_at, cancelled_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS seconds_since_create FROM reservations WHERE id = ? FOR UPDATE', [id])
        if (!rows.length) throw Object.assign(new Error('Reservation not found.'), { httpStatus: 404 })
        const reservation = rows[0]
        if (user.role !== 'MIS' && Number(reservation.reserved_by) !== Number(user.id)) throw Object.assign(new Error('You may only undo creation of your own reservation.'), { httpStatus: 403 })
        const age = Number(reservation.seconds_since_create)
        if (!Number.isFinite(age) || age < 0 || !reservation.created_at) throw Object.assign(new Error('This reservation has no valid creation record to undo.'), { httpStatus: 409 })
        if (!['PENDING', 'DECLINED'].includes(String(reservation.status).toUpperCase()) || reservation.decided_by != null || reservation.decided_at != null || reservation.cancelled_at != null) {
            throw Object.assign(new Error('This reservation has already been processed and cannot have its creation undone.'), { httpStatus: 409 })
        }
        const result = await run("DELETE FROM reservations WHERE id = ? AND status = ? AND created_at = ? AND decided_by IS NULL AND decided_at IS NULL AND cancelled_at IS NULL", [id, reservation.status, reservation.created_at])
        if (!result.affectedRows) throw Object.assign(new Error('Reservation changed before the undo could be applied.'), { httpStatus: 409 })
        await finishTransaction('commit')
        transaction = false
        logAudit(user.id, 'RESERVATION CREATION UNDONE', `Creation undone for reservation #${id}`)
        return response.json({ message: 'Reservation creation undone.' })
    } catch (error) {
        if (transaction && connection) {
            try { await finishTransaction('rollback') } catch (rollbackError) { console.error('Reservation creation undo rollback failed:', rollbackError.code || rollbackError.message) }
        }
        console.error('Unable to undo reservation creation:', error.code || error.message)
        if (error.httpStatus) return response.status(error.httpStatus).json({ message: error.message })
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') return response.status(409).json({ message: 'Another reservation update is in progress. Refresh and retry the undo.' })
        return response.status(500).json({ message: 'Unable to undo reservation creation; no changes were saved.' })
    } finally { connection?.release() }
}

function completeReservation(request, response) {

    const { id } = request.params

    const sql = `
        UPDATE reservations

        SET status = 'COMPLETED'

        WHERE id = ?
        AND status = 'APPROVED'
    `

    getDb().query(
        sql,
        [id],
        (error, results) => {

            if (error) {

                return response.status(500).json({
                    message:
                        'Unable to complete reservation.'
                })
            }

            if (results.affectedRows === 0) {

                return response.status(404).json({
                    message:
                        'Reservation not found.'
                })
            }

            return response.status(200).json({
                message:
                    'Reservation completed successfully.'
            })
        }
    )
}


module.exports = {
    getPeriodAvailability,
    BLOCKING_STATUS_SQL,
    NEW_REQUEST_BLOCKING_SQL,
    getReservations,
    createReservation,
    decideReservation,
    cancelReservation,
    undoCancelReservation,
    undoDecisionReservation,
    undoCreateReservation,
    canUndoReservationDecision,
    isTimeAlignedToInterval,
    validateReservationWindow,
    OVERLAP_SQL,
    completeReservation,
    getManilaDateString,
    getManilaTimeString,
    getManilaMinutes,
    isValidDateString,
    isSundayDateString,
    getReservationSession
}
