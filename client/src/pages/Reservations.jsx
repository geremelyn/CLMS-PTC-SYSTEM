import { deletedMessage } from '../utils/deleteInfo.js'
import PagePager from '../components/PagePager.jsx'
import { postDeleteInBatches, postRestoreInBatches } from '../utils/batchDelete.js'
import { useClmsDialog } from '../components/ClmsDialog.jsx';
import { customRoleName } from '../utils/roleDisplay.js'
import { PERIOD_PRESETS, startOptionsForPeriod, endOptionsForPeriod, formatTimeLabel, isDateClosed, busyNote, describeProfessor, formatDateRequested } from '../utils/reservationTime.js'
import { useEffect, useMemo, useState } from 'react'
import { sortReservationsNewestFirst } from '../utils/reservationSorting.mjs'
import api from '../api'
import DatePicker from '../components/DatePicker'
import { isClosedHoliday, useHolidayMap } from '../utils/holidays'
import { useNavigate } from 'react-router-dom'
import './Reservations.css'

const API = ''

function getTodayLocal() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date())
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
}

function Reservations() {
    const { confirm, prompt, undoToast } = useClmsDialog();
    const navigate = useNavigate()

    const user = JSON.parse(localStorage.getItem('user') || 'null')

    const role = user?.role || ''

    const isMIS = role === 'MIS'
    const isDean = role === 'Dean'
    const isTeacher = role === 'Teacher' || role === 'Others' // custom roles behave like Teachers for reservations
    const isInventory = role === 'Inventory Staff'

    const canReserve = isMIS || isDean || isTeacher

    const dashboardPath = isMIS
        ? '/mis-dashboard'
        : isDean
            ? '/dean-dashboard'
            : isTeacher
                ? '/teacher-dashboard'
                : '/inventory-dashboard'

    const [reservations, setReservations] = useState([])
    const [laboratories, setLaboratories] = useState([])

    const [scheduleDate, setScheduleDate] = useState(getTodayLocal())
    const { map: holidayMap } = useHolidayMap([Number(String(scheduleDate || getTodayLocal()).slice(0, 4))])
    const scheduleHoliday = holidayMap.get(scheduleDate)
    const scheduleDateClosed = isClosedHoliday(scheduleHoliday)
    const [scheduleLaboratoryId, setScheduleLaboratoryId] = useState('')
    const [scheduleSearchTerm, setScheduleSearchTerm] = useState('')

    const [periodModalOpen, setPeriodModalOpen] = useState(false)
    const [selectedPeriod, setSelectedPeriod] = useState('MORNING')
    const [availability, setAvailability] = useState(null)
    const [availabilityLoading, setAvailabilityLoading] = useState(false)
    const [availabilityError, setAvailabilityError] = useState('')
    const [popupError, setPopupError] = useState('')
    const [saving, setSaving] = useState(false)
    const [purpose, setPurpose] = useState('')
    const [subjectName, setSubjectName] = useState('')
    const [startTime, setStartTime] = useState('')
    const [endTime, setEndTime] = useState('')


    const [cancellingReservation, setCancellingReservation] = useState(null)
    const [cancellationNote, setCancellationNote] = useState('')

    const [loading, setLoading] = useState(true)

    // =========================================================
    // LOAD LABORATORIES
    // =========================================================

    async function getLaboratories() {
        try {
            const response = await api.get(`${API}/laboratories`)

            const labs = response.data.laboratories || []

            setLaboratories(labs)

            if (labs.length > 0 && !scheduleLaboratoryId) {
                setScheduleLaboratoryId(String(labs[0].id))
            }
        } catch (error) {
            console.error(
                'Unable to load laboratories:',
                error.response?.data?.message || error.message
            )
        }
    }

    // =========================================================
    // LOAD RESERVATIONS
    // =========================================================

    async function getReservations({ silent = false } = {}) {
        try {
            if (!silent) setLoading(true)

            const response = await api.get(`${API}/reservations`)

            setReservations(response.data.reservations || [])
        } catch (error) {
            console.error(
                'Unable to load reservations:',
                error.response?.data?.message || error.message
            )

            // A failed background refresh must never blank the table.
            if (!silent) setReservations([])
        } finally {
            if (!silent) setLoading(false)
        }
    }

    useEffect(() => {
        // This effect intentionally starts an API fetch; state updates occur when the request resolves.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        getLaboratories()
        getReservations()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / selected filter changes
    }, [])

    // MIS is a monitoring role, so keep its reservation list fresh while the
    // page is open. This lets a Teacher or Dean reservation appear almost
    // immediately without requiring MIS to leave and reopen the page.
    useEffect(() => {
        if (!isMIS && !isInventory) return undefined

        const refresh = () => {
            if (document.visibilityState === 'visible') getReservations({ silent: true })
        }

        const interval = window.setInterval(refresh, 2000)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)

        return () => {
            window.clearInterval(interval)
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [isMIS, isInventory])

    // =========================================================
    // HELPERS
    // =========================================================

    // Every reservation action reports its result in a centered popup (never a top/bottom banner).
    function showMessage(text, type = 'success') {
        if (!text) return
        undoToast(text, null, { title: type === 'error' ? 'Error' : 'Success', error: type === 'error', durationMs: type === 'error' ? 6500 : 4500 })
    }

    function formatTime(time) {
        if (!time) return '-'

        const [hour, minute] = time.slice(0, 5).split(':')

        const date = new Date()

        date.setHours(
            Number(hour),
            Number(minute),
            0,
            0
        )

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        })
    }

    function formatDate(date) {
        if (!date) return '-'

        const value = new Date(`${date}T00:00:00`)

        return value.toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        })
    }

    const scheduleLaboratory = useMemo(() => {
        return laboratories.find(
            laboratory =>
                Number(laboratory.id) ===
                Number(scheduleLaboratoryId)
        )
    }, [laboratories, scheduleLaboratoryId])

    // =========================================================
    // BOOKING
    // =========================================================

    // Morning / Afternoon availability for the selected laboratory + date (re-checked again by the server on SAVE).
    async function loadAvailability(laboratoryId = scheduleLaboratoryId, date = scheduleDate) {
        if (!laboratoryId || !date) return
        setAvailabilityLoading(true)
        setAvailabilityError('')
        try {
            const response = await api.get(`${API}/reservations/availability`, { params: { laboratory_id: laboratoryId, date } })
            setAvailability(response.data)
        } catch (error) {
            setAvailability(null)
            setAvailabilityError(error.response?.data?.message || 'Unable to check availability. Please try again.')
        } finally {
            setAvailabilityLoading(false)
        }
    }

    useEffect(() => {
        if (!periodModalOpen) return
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadAvailability(scheduleLaboratoryId, scheduleDate)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the popup opens or the lab/date changes
    }, [periodModalOpen, scheduleLaboratoryId, scheduleDate])

    function openPeriodPopup() {
        if (!canReserve || scheduleLaboratory?.status !== 'OPEN' || !scheduleDate || scheduleDateClosed) return
        setAvailability(null)
        setSelectedPeriod('MORNING')
        setStartTime('')
        setEndTime('')
        setPopupError('')
        setPeriodModalOpen(true)
    }

    function closePeriodPopup() {
        // CANCEL: nothing is saved or submitted.
        setPeriodModalOpen(false)
        setSelectedPeriod('MORNING')
        setStartTime('')
        setEndTime('')
        setPopupError('')
        setPurpose('')
        setSubjectName('')
    }

    function clearBookingForm() {
        setPeriodModalOpen(false)
        setSelectedPeriod('MORNING')
        setStartTime('')
        setEndTime('')
        setPopupError('')
        setPurpose('')
        setSubjectName('')
    }

    async function handleCreateReservation() {
        if (user?.id === undefined || user?.id === null) {
            showMessage(
                'Your user session is missing. Please log in again.',
                'error'
            )

            return
        }

        if (!canReserve) {
            showMessage(
                'You are not authorized to create reservations.',
                'error'
            )

            return
        }

        if (!scheduleLaboratoryId) {
            showMessage(
                'Please select a laboratory.',
                'error'
            )

            return
        }

        if (!scheduleDate) {
            showMessage(
                'Please select a reservation date.',
                'error'
            )

            return
        }

        if (scheduleLaboratory?.status !== 'OPEN' || !scheduleDate) {
            showMessage('Choose an open laboratory and a reservation date.', 'error')
            return
        }

        if (!startTime || !endTime) {
            setPopupError('Please choose a start time and an end time.')
            return
        }
        if (endTime <= startTime) {
            setPopupError('The end time must be later than the start time.')
            return
        }

        // Professor name and role always come from the logged-in account; only subject and purpose are typed.
        const professor = describeProfessor(user)
        if (!subjectName.trim() || !purpose.trim()) {
            setPopupError('Please enter the subject name and purpose.')
            return
        }
        if (!professor.name && !isMIS) {
            setPopupError('Your account has no full name on file, so the professor name cannot be filled in. Please contact the MIS office.')
            return
        }

        setPopupError('')
                if (!await confirm(`Submit this reservation request for ${scheduleDate}, ${formatTimeLabel(startTime)} – ${formatTimeLabel(endTime)}?`, { title: 'Submit reservation', confirmLabel: 'Submit' })) return
        setSaving(true)
        try {
            const response = await api.post(
                `${API}/reservations`,
                {
                    laboratory_id:
                        scheduleLaboratoryId,

                    reserved_by:
                        user.id,

                    reservation_date:
                        scheduleDate,

                    start_time: startTime,
                    end_time: endTime,

                    purpose:
                        purpose.trim(),
                    subject_name: subjectName.trim(),
                    professor_name: professor.name
                }
            )

            if (response.data.auto_declined) {
                showMessage(response.data.message, 'error')
            } else {
                showMessage(
                    response.data.message ||
                    'Reservation created successfully.',
                    'success'
                )
            }

            clearBookingForm()

            await getReservations()
        } catch (error) {
            const text = error.response?.data?.message || 'Unable to create reservation.'
            if (error.response?.status === 409 || error.response?.data?.code === 'SLOT_TAKEN') {
                // Another reservation overlaps these exact times: keep the popup and the chosen times, show the server's message.
                setPopupError(text)
                await loadAvailability()
            } else {
                setPopupError(text)
            }
        } finally {
            setSaving(false)
        }
    }

    // =========================================================
    // CANCEL RESERVATION
    // =========================================================

    function openCancellation(reservation) {
        if (!reservation) {
            return
        }

        const ownerId =
            Number(reservation.reserved_by)

        const currentUserId =
            Number(user?.id)

        // MIS may cancel anyone.
        if (isMIS) {
            setCancellingReservation(reservation)
            setCancellationNote('')
            return
        }

        // Dean / Teacher may cancel own reservation only.
        if (
            (isDean || isTeacher) &&
            ownerId === currentUserId
        ) {
            setCancellingReservation(reservation)
            setCancellationNote('')
            return
        }

        showMessage(
            'You may only cancel your own reservation.',
            'error'
        )
    }

    function closeCancellation() {
        setCancellingReservation(null)
        setCancellationNote('')
    }

    async function submitCancellation(event) {
        event.preventDefault()

        if (!cancellingReservation) {
            return
        }

        if (user?.id === undefined || user?.id === null) {
            showMessage(
                'Your user session is missing.',
                'error'
            )

            return
        }

        // MIS MUST provide a note.
        if (
            isMIS &&
            !cancellationNote.trim()
        ) {
            showMessage(
                'MIS must provide a cancellation note.',
                'error'
            )

            return
        }

        if (!await confirm('Confirm cancellation of this reservation?', { title: 'Cancel reservation', confirmLabel: 'Confirm' })) return
        try {
            const response = await api.put(
                `${API}/reservations/${cancellingReservation.id}/cancel`,
                {
                    user_id: user.id,
                    cancellation_note:
                        cancellationNote.trim()
                }
            )

            showMessage(
                response.data.message ||
                'Reservation cancelled successfully.',
                'success'
            )

            closeCancellation()

            await getReservations()
        } catch (error) {
            showMessage(
                error.response?.data?.message ||
                'Unable to cancel reservation.',
                'error'
            )
        }
    }

    function canUndoCreation(reservation) {
        if (!reservation?.created_at || !['PENDING', 'DECLINED'].includes(String(reservation.status).toUpperCase())) return false
        if (reservation.decided_by != null || reservation.decided_at || reservation.cancelled_at) return false
        if (!isMIS && Number(reservation.reserved_by) !== Number(user?.id)) return false
        const created = new Date(String(reservation.created_at).replace(' ', 'T')).getTime()
        return Number.isFinite(created)
    }

    async function undoCreation(reservation) {
        if (!await confirm('Undo creation of this reservation? It will be removed only if it has not been processed yet.')) return
        try {
            const response = await api.put(`${API}/reservations/${reservation.id}/undo-create`)
            showMessage(response.data.message || 'Reservation creation undone.', 'success')
            await getReservations()
        } catch (error) {
            showMessage(error.response?.data?.message || 'Unable to undo reservation creation.', 'error')
        }
    }

    async function undoCancellation(reservation) {
        if (!await confirm('Undo this cancellation and restore the reservation to Approved?')) return;
        try {
            const response = await api.put(`${API}/reservations/${reservation.id}/undo-cancel`);
            showMessage(response.data.message || 'Cancellation undone.', 'success');
            await getReservations();
        } catch (error) { showMessage(error.response?.data?.message || 'Unable to undo cancellation.', 'error'); }
    }

    function canUndoCancellation(reservation) {
        if (!reservation.cancelled_at) return false;
        if (String(reservation.cancellation_note || '').startsWith('Automatically cancelled:')) return false; // CP25: automatic cancellations are final
        // Only the person who cancelled may undo it (older rows without a recorded canceller: the owner only).
        if (reservation.cancelled_by != null && Number(reservation.cancelled_by) !== Number(user?.id)) return false;
        const cancelledAt = new Date(reservation.cancelled_at).getTime();
        return Number.isFinite(cancelledAt);
    }

    // =========================================================
    // RESERVATION LIST
    // =========================================================

    const myReservations = useMemo(() => {
        return reservations.filter(
            reservation =>
                Number(reservation.reserved_by) ===
                Number(user?.id)
        )
    }, [reservations, user?.id])

    const visibleReservations = useMemo(() => {
        if (isMIS || isDean) {
            return reservations
        }

        return myReservations
    }, [
        isMIS,
        isDean,
        reservations,
        myReservations
    ])

    // =========================================================
    // LOGOUT
    // =========================================================

    function handleLogout() {
        localStorage.removeItem('user')
        navigate('/')
    }

    // =========================================================
    // RENDER
    // =========================================================

    // MIS uses this page as a reservation management/monitoring screen.
    // It does not create reservations from this screen; creation belongs to the
    // reservation flow used by Dean and Teacher.
    if (isMIS || isInventory) {
        return (
            <MISReservationManagement
                user={user}
                reservations={reservations}
                laboratories={laboratories}
                loading={loading}
                navigate={navigate}
                onRetry={() => getReservations({ silent: true })}
                formatDate={formatDate}
                formatTime={formatTime}
            />
        )
    }

    return (
        <div className="reservation-page">

            <div className="reservation-overlay" />

            {/* HEADER */}

            <header className="reservation-header">

                <div className="reservation-brand">

                    <img
                        src="/clms-logo.png"
                        alt="CLMS Logo"
                    />

                    <div>
                        <h1>CLMS</h1>
                        <span>
                            Pateros Technological College
                        </span>
                    </div>

                </div>

                <div className="reservation-user">

                    <div className="reservation-avatar">
                        {user?.full_name
                            ?.charAt(0)
                            ?.toUpperCase() || 'U'}
                    </div>

                    <div className="reservation-user-info">
                        <strong>
                            {user?.full_name || 'User'}
                        </strong>

                        <span>
                            {customRoleName(role, user?.role_other) || role}
                        </span>
                    </div>

                </div>

            </header>

            <div className="reservation-layout">

                {/* SIDEBAR */}

                <aside className="reservation-sidebar">

                    <p>MAIN MENU</p>

                    <button
                        type="button"
                        onClick={() =>
                            navigate(dashboardPath)
                        }
                    >
                        Dashboard
                    </button>

                    {isTeacher && (
                        <>
                            <button type="button" className="active">Reserve Laboratory</button>
                            <button type="button" onClick={() => navigate('/my-reservations')}>My Reservations</button>
                            {isTeacher && <button type="button" onClick={() => navigate('/report-issue')}>Report Issue</button>}
                            {isTeacher && <button type="button" onClick={() => navigate('/reports')}>{role === 'Others' ? 'My Reports' : 'Reports'}</button>}
                            <button type="button" onClick={() => navigate('/change-password')}>Change Password</button>
                        </>
                    )}

                    {isDean && (
                        <>
                            <button type="button" className="active">Reserve Laboratory</button>
                            <button type="button" onClick={() => navigate('/my-reservations')}>My Reservations</button>
                            <button type="button" onClick={() => navigate('/reports')}>Reports</button><button type="button" onClick={() => navigate('/change-password')}>Change Password</button>
                        </>
                    )}

                    {isMIS && (
                        <>
                            <button
                                type="button"
                                onClick={() =>
                                    navigate('/users')
                                }
                            >
                                User Management
                            </button>

                            <button
                                type="button"
                                className="active"
                            >
                                Reservations
                            </button>

                            <button
                                type="button"
                                onClick={() =>
                                    navigate('/equipment')
                                }
                            >
                                Assets & Equipment
                            </button>

                            <button
                                type="button"
                                onClick={() =>
                                    navigate('/reports')
                                }
                            >
                                Reports
                            </button>

                            <button type="button" onClick={() => navigate('/audit-log')}>Audit Log</button>
                            <button type="button" onClick={() => navigate('/change-password')}>Change Password</button>

                        </>
                    )}

                    <div className="sidebar-line" />

                    <button
                        type="button"
                        className="logout"
                        onClick={handleLogout}
                    >
                        Logout
                    </button>

                </aside>

                {/* MAIN */}

                <main className="reservation-content">
                    <h1 className="clms-page-title">Reserve Laboratory</h1>

                    {/* SCHEDULE */}

                    <section className="glass-card">

                        {/* CONTROLS */}

                        <div className="schedule-controls">

                            <div>

                                <label htmlFor="schedule-date">
                                    Reservation Date
                                </label>

                                <DatePicker
                                    id="schedule-date"
                                    showHolidayList={!(isDean || isTeacher)}
                                    min={getTodayLocal()}
                                    value={scheduleDate}
                                    onChange={value => {
                                        setScheduleDate(value)
                                        clearBookingForm()
                                        if (canReserve && value && !isClosedHoliday(holidayMap.get(value)) && scheduleLaboratory?.status === 'OPEN') {
                                            setAvailability(null)
                                            setPopupError('')
                                            setPeriodModalOpen(true)
                                        }
                                    }}
                                />

                            </div>

                            <div>

                                <label htmlFor="schedule-laboratory">
                                    Laboratory
                                </label>

                                <select
                                    id="schedule-laboratory"
                                    value={scheduleLaboratoryId}
                                    onChange={event => {
                                        setScheduleLaboratoryId(event.target.value)
                                        clearBookingForm()
                                    }}
                                >

                                    {laboratories.map(
                                        laboratory => (
                                            <option
                                                key={
                                                    laboratory.id
                                                }
                                                value={
                                                    laboratory.id
                                                }
                                            >
                                                {
                                                    laboratory.laboratory_name
                                                }
                                            </option>
                                        )
                                    )}

                                </select>

                            </div>

                        </div>

                        {/* Non-open laboratories show only their status and date/reason details. */}
                        {scheduleLaboratory && scheduleLaboratory.status !== 'OPEN' && (
                            <div className="table-container laboratory-status-table">
                                <table>
                                    <thead>
                                        {scheduleLaboratory.status === 'UNAVAILABLE' ?
                                            <tr><th>Laboratory</th><th>Status</th><th>Unavailable From</th><th>Unavailable Until</th><th>Reason</th></tr> :
                                            <tr><th>Laboratory</th><th>Status</th><th>Used From</th><th>Used Until</th></tr>}
                                    </thead>
                                    <tbody><tr>
                                        <td>{scheduleLaboratory.laboratory_name}</td>
                                        <td>{scheduleLaboratory.status}</td>
                                        {scheduleLaboratory.status === 'UNAVAILABLE' ? <><td>{scheduleLaboratory.unavailable_from || '—'}</td><td>{scheduleLaboratory.unavailable_until || '—'}</td><td>{scheduleLaboratory.reason || '—'}</td></> : <><td>{scheduleLaboratory.used_from || '—'}</td><td>{scheduleLaboratory.used_until || '—'}</td></>}
                                    </tr></tbody>
                                </table>
                            </div>
                        )}

                    </section>

                    {scheduleHoliday && !(isDean || isTeacher) && <div className={`holiday-banner ${scheduleDateClosed ? 'closed' : 'working'}`} role="status">
                        <strong>{scheduleHoliday.name}</strong> — {scheduleHoliday.type_label}. {scheduleDateClosed ? 'Laboratory reservations are not available on this date. Please choose another date.' : 'This is a working day; reservations are open.'}
                    </div>}

                    {/* BOOKING FORM */}

                    {scheduleLaboratory?.status === 'OPEN' && scheduleDate && canReserve && !scheduleDateClosed && (

                        <section className="booking-box">

                            {/* CP92: the "NEW RESERVATION / Reserve Laboratory" header repeated the page title; it is hidden for Dean and Teacher. */}

                            {!(isDean || isTeacher) && <div className="booking-header"><div><span>NEW RESERVATION</span><h3>Reserve Laboratory</h3></div></div>}

                            <div className="booking-grid">

                                <div>
                                    <label>Date</label>

                                    <strong>
                                        {formatDate(
                                            scheduleDate
                                        )}
                                    </strong>
                                </div>

                                <div>
                                    <label>Laboratory</label>

                                    <strong>
                                        {
                                            scheduleLaboratory?.laboratory_name
                                        }
                                    </strong>
                                </div>

                                <div className="purpose">
                                    <label>Reservation Period</label>
                                    <small>Choose Morning or Afternoon, then your start and end time (7:00 AM – 9:00 PM). Only overlapping reservations are rejected.</small>
                                </div>

                            </div>

                            <div className="booking-actions">

                                <button
                                    type="button"
                                    className="confirm-btn"
                                    onClick={openPeriodPopup}
                                >
                                    Choose Start &amp; End Time
                                </button>

                            </div>

                        </section>

                    )}

                    {/* MORNING / AFTERNOON POPUP */}
                    {periodModalOpen && canReserve && (
                        <div className="reservation-modal-backdrop" role="presentation">
                            <div className="reservation-modal period-modal" role="dialog" aria-modal="true" aria-labelledby="period-modal-title">
                                <div className="reservation-modal-head">
                                    <div>
                                        <span>NEW RESERVATION</span>
                                        <h3 id="period-modal-title">Choose Start &amp; End Time</h3>
                                        <p className="period-modal-sub">{scheduleLaboratory?.laboratory_name} · {formatDate(scheduleDate)}</p>
                                    </div>
                                </div>

                                {availabilityLoading && !availability && <p className="period-note">Checking availability…</p>}
                                {availabilityError && <p className="period-note period-error" role="alert">{availabilityError}</p>}

                                {(() => {
                                    const closed = isDateClosed(availability)
                                    const professor = describeProfessor(user)
                                    return (<>
                                        {closed && availability?.message && <p className="period-note period-error" role="alert">{availability.message}</p>}
                                        {!closed && busyNote(availability) && <p className="period-note">{busyNote(availability)}</p>}
                                        {!closed && availability && (
                                            <div className="reservation-form-grid period-details">
                                                <div className="reservation-form-full period-options" role="group" aria-label="Morning or Afternoon">
                                                    {Object.entries(PERIOD_PRESETS).map(([key, preset]) => (
                                                        <button key={key} type="button" className={`period-option${selectedPeriod === key ? ' selected' : ''}`} disabled={saving}
                                                            onClick={() => { if (key !== selectedPeriod) { setSelectedPeriod(key); setStartTime(''); setEndTime('') } setPopupError('') }}>
                                                            <strong>{preset.label}</strong>
                                                        </button>
                                                    ))}
                                                </div>
                                                <label>Start Time
                                                    <select value={startTime} disabled={saving} onChange={event => { const value = event.target.value; setStartTime(value); setPopupError(''); if (endTime && endTime <= value) setEndTime('') }}>
                                                        <option value="">Select start</option>
                                                        {startOptionsForPeriod(selectedPeriod).map(option => <option key={option} value={option}>{formatTimeLabel(option)}</option>)}
                                                    </select>
                                                </label>
                                                <label>End Time
                                                    <select value={endTime} disabled={saving} onChange={event => { setEndTime(event.target.value); setPopupError('') }}>
                                                        <option value="">Select end</option>
                                                        {endOptionsForPeriod(selectedPeriod, startTime).map(option => <option key={option} value={option}>{formatTimeLabel(option)}</option>)}
                                                    </select>
                                                </label>
                                                <label className="reservation-form-full">Professor
                                                    <input type="text" readOnly value={professor.name ? `${professor.name}${professor.role ? ` (${professor.role})` : ''}` : (professor.role || '')} aria-readonly="true" />
                                                </label>
                                                <label className="reservation-form-full">Subject Name
                                                    <input type="text" maxLength={150} value={subjectName} onChange={event => setSubjectName(event.target.value)} placeholder="e.g. Programming 2" />
                                                </label>
                                                <label className="reservation-form-full">Purpose
                                                    <input type="text" maxLength={255} value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="Reason for laboratory use" />
                                                </label>
                                            </div>
                                        )}
                                    </>)
                                })()}

                                {popupError && <p className="period-note period-error" role="alert">{popupError}</p>}

                                <div className="reservation-modal-actions">
                                    <button type="button" onClick={closePeriodPopup} disabled={saving}>CANCEL</button>
                                    <button type="button" className="reservation-create-button" onClick={handleCreateReservation} disabled={saving || availabilityLoading || !availability || isDateClosed(availability) || !startTime || !endTime}>
                                        {saving ? 'SAVING…' : 'SAVE'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* RESERVATION RECORDS — MIS ONLY */}
                    {isMIS && (

                    <section className="glass-card my-reservations-card">

                        <div className="card-title">

                            <div>

                                <span>
                                    {isMIS || isDean
                                        ? 'RESERVATION MONITORING'
                                        : 'YOUR ACTIVITY'}
                                </span>

                                <h3>
                                    {isMIS || isDean
                                        ? 'Reservation Records'
                                        : 'My Reservations'}
                                </h3>

                            </div>

                        </div>

                        <div className="reservation-search-row"><label htmlFor="reservation-schedule-search">Search all schedule fields</label><input id="reservation-schedule-search" type="search" value={scheduleSearchTerm} onChange={event => setScheduleSearchTerm(event.target.value)} placeholder="Search time, reservation, purpose, status, teacher…" /></div>
                        <div className="table-container">

                            <table>

                                <thead>

                                    <tr>
                                        <th>LABORATORY</th>
                                        <th>RESERVATION DATE &amp; TIME</th>
                                        <th>DATE REQUESTED</th>
                                        <th>PURPOSE / SUBJECT</th>
                                        <th>REQUESTER DETAILS</th>
                                        <th>STATUS</th>
                                        <th>ACTION</th>
                                    </tr>

                                </thead>

                                <tbody>

                                    {loading ? (

                                        <tr>
                                            <td
                                                colSpan="7"
                                                className="empty-table"
                                            >
                                                Loading reservations...
                                            </td>
                                        </tr>

                                    ) : visibleReservations.length === 0 ? (

                                        <tr>
                                            <td
                                                colSpan="7"
                                                className="empty-table"
                                            >
                                                No reservations found.
                                            </td>
                                        </tr>

                                    ) : (

                                        visibleReservations.map(
                                            reservation => {

                                                const canCancelThis =
                                                    isMIS ||
                                                    (
                                                        (
                                                            isDean ||
                                                            isTeacher
                                                        ) &&
                                                        Number(
                                                            reservation.reserved_by
                                                        ) ===
                                                        Number(
                                                            user?.id
                                                        )
                                                    )

                                                return (
                                                    <tr
                                                        key={
                                                            reservation.id
                                                        }
                                                    >

                                                        <td>
                                                            {
                                                                reservation.laboratory_name
                                                            }
                                                        </td>

                                                        <td>
                                                            {reservation.formatted_reservation_date || reservation.reservation_date || '—'}
                                                            <br />
                                                            <small>{formatTime(reservation.start_time)} – {formatTime(reservation.end_time)}</small>
                                                        </td>

                                                        <td>{formatDateRequested(reservation.created_at)}</td>

                                                        <td>
                                                            {reservation.purpose || '—'}
                                                            <br />
                                                            <small>Subject: {reservation.subject_name || '—'}<br />Professor: {reservation.professor_name || '—'}</small>
                                                        </td>

                                                        <td>
                                                            <strong>{reservation.reserved_by_role === 'MIS' ? 'System' : (reservation.reserved_by_name || '—')}</strong>
                                                            <br />
                                                            <small>{reservation.reserved_by_username ? `ID Number: ${reservation.reserved_by_username}` : ''}{reservation.reserved_by_program ? ` · ${reservation.reserved_by_program}` : ''}{reservation.reserved_by_role ? ` · ${customRoleName(reservation.reserved_by_role, reservation.reserved_by_role_other) || (reservation.reserved_by_role === 'Inventory Staff' ? 'MIS Staff' : reservation.reserved_by_role)}` : ''}</small>
                                                        </td>

                                                        <td>

                                                            <span
                                                                className={
                                                                    `status ${String(
                                                                        reservation.status
                                                                    ).toLowerCase()}`
                                                                }
                                                            >
                                                                {
                                                                    reservation.status
                                                                }
                                                            </span>

                                                        </td>

                                                        <td>

                                                            {canUndoCreation(reservation) ? (
                                                                <button type="button" className="table-action" onClick={() => undoCreation(reservation)}>Undo creation</button>
                                                            ) : reservation.status === 'APPROVED' &&
                                                            canCancelThis ? (

                                                                <button
                                                                    type="button"
                                                                    className="table-action cancel-action"
                                                                    onClick={() =>
                                                                        openCancellation(
                                                                            reservation
                                                                        )
                                                                    }
                                                                >
                                                                    Cancel
                                                                </button>

                                                            ) : reservation.status === 'CANCELLED' && canCancelThis && canUndoCancellation(reservation) ? (
                                                                <button type="button" className="table-action" onClick={() => undoCancellation(reservation)}>Undo cancellation</button>
                                                            ) : (
                                                                <span className="action-muted">—</span>
                                                            )}

                                                        </td>

                                                    </tr>
                                                )
                                            }
                                        )

                                    )}

                                </tbody>

                            </table>

                        </div>

                    </section>

                    )}

                </main>

            </div>

            {/* CANCELLATION MODAL */}

            {cancellingReservation && (

                <div
                    className="modal-bg"
                    role="presentation"
                >

                    <div
                        className="cancel-modal"
                        role="dialog"
                        aria-modal="true"
                    >

                        <span>
                            RESERVATION ACTION
                        </span>

                        <h2>
                            Cancel Reservation
                        </h2>

                        <div className="cancel-details">

                            <strong>
                                {
                                    cancellingReservation.laboratory_name
                                }
                            </strong>

                            <p>
                                {
                                    cancellingReservation.formatted_reservation_date
                                }
                            </p>

                            <p>
                                {formatTime(
                                    cancellingReservation.start_time
                                )}
                                {' - '}
                                {formatTime(
                                    cancellingReservation.end_time
                                )}
                            </p>

                            <p>
                                {
                                    cancellingReservation.reserved_by_name
                                }
                            </p>

                        </div>

                        {isMIS && (

                            <form
                                onSubmit={
                                    submitCancellation
                                }
                            >

                                <label htmlFor="cancellation-note">
                                    Cancellation Note
                                </label>

                                <textarea
                                    id="cancellation-note"
                                    value={
                                        cancellationNote
                                    }
                                    onChange={event =>
                                        setCancellationNote(
                                            event.target.value
                                        )
                                    }
                                    required
                                    placeholder="Enter the reason for cancelling this reservation."
                                />

                                <div className="modal-buttons">

                                    <button
                                        type="submit"
                                        className="confirm-btn"
                                    >
                                        Cancel Reservation
                                    </button>

                                    <button
                                        type="button"
                                        className="cancel-btn"
                                        onClick={
                                            closeCancellation
                                        }
                                    >
                                        Keep Reservation
                                    </button>

                                </div>

                            </form>

                        )}

                        {!isMIS && (

                            <div className="modal-buttons">

                                <button
                                    type="button"
                                    className="confirm-btn"
                                    onClick={() =>
                                        submitCancellation(
                                            {
                                                preventDefault:
                                                    () => {}
                                            }
                                        )
                                    }
                                >
                                    Yes, Cancel
                                </button>

                                <button
                                    type="button"
                                    className="cancel-btn"
                                    onClick={
                                        closeCancellation
                                    }
                                >
                                    Keep Reservation
                                </button>

                            </div>

                        )}

                    </div>

                </div>

            )}

        </div>
    )
}

function MISReservationManagement({ user, reservations, loading, navigate, onRetry, formatDate, formatTime }) {
    const { confirm, prompt, undoToast } = useClmsDialog();
    const isMISUser = user?.role === 'MIS'
    const [selectedIds, setSelectedIds] = useState([])
    const setActionMessage = text => { if (text) undoToast(text, null, { title: 'Success', durationMs: 4500 }) }
    const setActionError = text => { if (text) undoToast(text, null, { title: 'Error', error: true, durationMs: 6500 }) }
    const [cancelling, setCancelling] = useState(null)
    const [cancellationNote, setCancellationNote] = useState('')
    const [searchTerm, setSearchTerm] = useState('')
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page; page chosen with Previous / Next or a typed page number
    const sortedReservations = sortReservationsNewestFirst(reservations)
    const newestReservationId = sortedReservations[0]?.id ?? null
    useEffect(() => { setCurrentPage(1) }, [newestReservationId])
    const roleLabel = item => item.reserved_by_role === 'MIS' ? 'System' : item.reserved_by_role === 'Teacher' && item.reserved_by_program ? `${item.reserved_by_program}-Teacher` : item.reserved_by_role === 'Inventory Staff' ? 'MIS Staff' : (customRoleName(item.reserved_by_role, item.reserved_by_role_other) || item.reserved_by_role || '—')
    const search = searchTerm.trim().toLowerCase()
    const filteredReservations = sortedReservations.filter(item => !search || [item.laboratory_name, item.reservation_date, item.formatted_reservation_date, item.start_time, item.end_time, item.purpose, item.subject_name, item.professor_name, item.reserved_by_name, item.reserved_by_username, item.reserved_by_program, roleLabel(item), item.status, item.cancellation_note, item.decision_note].some(value => String(value ?? '').toLowerCase().includes(search)))
    const totalPages = Math.max(1, Math.ceil(filteredReservations.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const pageReservations = filteredReservations.slice((safePage - 1) * pageSize, safePage * pageSize)

    const filteredIds = filteredReservations.map(item => item.id)
    const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id))
    function toggleSelectAll() { setSelectedIds(allFilteredSelected ? [] : filteredIds) }
    function toggleOne(id) { setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]) }

    // Only finished reservations can be deleted. Pending and Approved ones are never sent to the server.
    const DELETABLE_STATUSES = ['COMPLETED', 'DECLINED', 'CANCELLED']
    const isDeletable = item => DELETABLE_STATUSES.includes(String(item?.status || '').toUpperCase())
    const validId = value => { const number = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN); return Number.isSafeInteger(number) && number > 0 ? number : null }

    async function deleteReservations() {
        // Delete All (nothing selected): only Completed/Declined/Cancelled rows. Delete Selected / individual delete: the rows the
        // Super Admin ticked, whatever their status, after the confirmation popup.
        const deleteAll = selectedIds.length === 0
        const pool = deleteAll ? filteredReservations : filteredReservations.filter(item => selectedIds.includes(item.id))
        const eligible = deleteAll ? pool.filter(isDeletable) : pool
        const activeCount = deleteAll ? pool.length - eligible.length : 0
        // A row without a usable numeric id is reported, never silently dropped and never sent to the server.
        const noIdRows = eligible.filter(item => validId(item.id) === null)
        // Say WHICH rows have no usable id (laboratory, date/time, status, who, the raw id value) so the record can be found and fixed in the database.
        const describeRow = item => `${item.laboratory_name || 'Unknown laboratory'} ${item.formatted_reservation_date || item.reservation_date || ''} ${item.start_time || ''}-${item.end_time || ''} (${item.status || 'no status'}${item.reserved_by_name ? `, ${item.reserved_by_name}` : ''}; id value: ${JSON.stringify(item.id) ?? 'missing'})`
        const noIdText = noIdRows.slice(0, 3).map(describeRow).join('; ') + (noIdRows.length > 3 ? `; and ${noIdRows.length - 3} more` : '')
        const ids = eligible.map(item => validId(item.id)).filter(id => id !== null)
        if (!ids.length) {
            // Every applicable problem is shown (an id-less row is never hidden behind the "Pending/Approved left untouched" text).
            const parts = []
            if (activeCount) parts.push(`Nothing to delete: Delete All only removes Completed, Declined and Cancelled reservations. ${activeCount} Pending/Approved reservation${activeCount === 1 ? ' was' : 's were'} left untouched.`)
            if (noIdRows.length) parts.push(`${noIdRows.length} reservation row(s) have no valid id, so nothing was deleted: ${noIdText}. Please report this to the administrator.`)
            setActionError(parts.length ? parts.join(' ') : 'There are no reservations to delete.'); return
        }
        const selectedActive = deleteAll ? 0 : eligible.filter(item => !isDeletable(item)).length
        const scope = deleteAll ? `all ${ids.length} deletable reservation${ids.length === 1 ? '' : 's'} (Completed, Declined, Cancelled)` : `${ids.length} selected reservation${ids.length === 1 ? '' : 's'}`
        const keep = activeCount ? ` ${activeCount} Pending/Approved reservation${activeCount === 1 ? ' is' : 's are'} not included and will stay untouched.` : (selectedActive ? ` ${selectedActive} of them ${selectedActive === 1 ? 'is' : 'are'} Pending/Approved.` : '')
        if (!await confirm(`Delete ${scope}? They will be moved to the Recycle Bin and can be restored at any time.${keep}`, { title: 'Delete reservations', confirmLabel: 'Delete', danger: true })) return
        try {
            const data = await postDeleteInBatches(body => api.post(`${API}/reservations/bulk-delete`, body), ids, deleteAll ? { skipMissing: true, deleteAll: true } : { skipMissing: false })
            setSelectedIds([])
            onRetry()
            // Real restore from the Recycle Bin (no 10-minute limit; this popup is only a shortcut - the Recycle Bin page always works).
            undoToast(deletedMessage(data, 'Successfully deleted.') + (noIdRows.length ? ` ${noIdRows.length} row(s) without a valid id were NOT deleted and still need attention: ${noIdText}.` : ''), async () => {
                const restored = await postRestoreInBatches(body => api.post(`${API}/recycle-bin/restore`, body), data.recycleIds)
                onRetry()
                return restored.message || 'Reservations restored.'
            }, { label: 'Restore', title: 'Deleted' })
        } catch (error) {
            if (error.partial?.deletedCount) { setSelectedIds([]); onRetry() }
            setActionError((error.partial?.deletedCount ? `${error.partial.deletedCount} reservation(s) were deleted before an error stopped the rest (they are in the Recycle Bin). ` : '') + (error.response?.data?.message || 'Unable to delete reservations.'))
        }
    }

    function openCancel(item) {
        setCancelling(item)
        setCancellationNote('')
        setActionMessage('')
    }

    function closeCancel() {
        setCancelling(null)
        setCancellationNote('')
    }

    async function handleDecision(item, decision) {
        if (!await confirm(`${decision === 'APPROVED' ? 'Approve' : 'Decline'} this reservation?`)) return;
        const decision_note = decision === 'DECLINED' ? await prompt('Reason for declining this reservation:') : '';
        if (decision === 'DECLINED' && !decision_note?.trim()) return;
        try { await api.put(`${API}/reservations/${item.id}/decision`, { decision, decision_note: decision_note?.trim() || '' }); setActionMessage(`Reservation #${item.id} ${decision.toLowerCase()}.`); onRetry(); }
        catch (error) { setActionError(error.response?.data?.message || 'Unable to process reservation.'); }
    }

    async function handleCancelSubmit(event) {
        event.preventDefault()
        if (!cancelling || !cancellationNote.trim()) return
        if (!await confirm('Confirm cancellation of this reservation?')) return
        try {
            await api.put(`${API}/reservations/${cancelling.id}/cancel`, { cancellation_note: cancellationNote.trim() })
            closeCancel()
            setActionMessage('Reservation cancelled successfully.')
            onRetry()
        } catch (error) {
            setActionError(error.response?.data?.message || 'Unable to cancel reservation.')
        }
    }

    async function undoCancellation(item) {
        if (!await confirm('Undo this cancellation and restore the reservation to Approved?')) return;
        try { await api.put(`${API}/reservations/${item.id}/undo-cancel`); setActionMessage(`Reservation #${item.id} cancellation undone.`); onRetry(); }
        catch (error) { setActionError(error.response?.data?.message || 'Unable to undo cancellation.'); }
    }
    function canUndoCancellation(item) {
        if (!item.cancelled_at) return false;
        // MIS sees "Undo cancellation" only for cancellations MIS itself made - never for a Teacher/Dean cancelling an approved reservation.
        if (!isMISUser || Number(item.cancelled_by) !== Number(user?.id)) return false;
        const cancelledAt = new Date(item.cancelled_at).getTime();
        return Number.isFinite(cancelledAt);
    }
    async function undoDecision(item) {
        const prior = String(item.status || '').toLowerCase()
        if (!await confirm(`Undo this ${prior} decision and return the reservation to Pending?`)) return
        try { const response = await api.put(`${API}/reservations/${item.id}/undo-decision`); setActionMessage(response.data.message || 'Reservation decision undone.'); onRetry() }
        catch (error) { setActionError(error.response?.data?.message || 'Unable to undo reservation decision.') }
    }
    function canUndoDecision(item) {
        // The server re-validates every undo; do not depend on browser date parsing of decided_at (MySQL strings fail in some browsers).
        return ['APPROVED', 'DECLINED'].includes(item.status) && item.decided_by != null && Boolean(item.decided_at)
    }

    return (
        <div className="reservation-page">
            <div className="reservation-overlay" />
            <header className="reservation-header">
                <div className="reservation-brand">
                    <img src="/clms-logo.png" alt="CLMS Logo" />
                    <div><h1>CLMS</h1><span>Pateros Technological College</span></div>
                </div>
                <div className="reservation-user">
                    <div className="reservation-avatar">{user?.full_name?.charAt(0)?.toUpperCase() || 'M'}</div>
                    <div className="reservation-user-info"><strong>{user?.full_name || 'MIS Staff'}</strong><span>{user?.role === 'Inventory Staff' ? 'MIS Staff' : 'MIS'}</span></div>
                </div>
            </header>
            <div className="reservation-layout">
                <aside className="reservation-sidebar">
                    <p>MAIN MENU</p>
                    {isMISUser ? <>
                        <button type="button" onClick={() => navigate('/mis-dashboard')}>Dashboard</button>
                        <button type="button" onClick={() => navigate('/users')}>User Management</button>
                        <button type="button" onClick={() => navigate('/laboratories')}>Laboratories</button>
                        <button type="button" onClick={() => navigate('/computers')}>Computers</button>
                        <button type="button" className="active">Reservations</button>
                        <button type="button" onClick={() => navigate('/equipment')}>Assets &amp; Equipment</button>
                        <button type="button" onClick={() => navigate('/reports')}>Reports</button>
                    </> : <>
                        <button type="button" onClick={() => navigate('/inventory-dashboard')}>Dashboard</button>
                        <button type="button" className="active">Reservations</button>
                        <button type="button" onClick={() => navigate('/equipment')}>Assets &amp; Equipment</button>
                        <button type="button" onClick={() => navigate('/computers')}>Computers</button>
                        <button type="button" onClick={() => navigate('/maintenance')}>Maintenance</button>
                        <button type="button" onClick={() => navigate('/maintenance-history')}>Maintenance History</button>
                        <button type="button" onClick={() => navigate('/reports')}>Reports</button>
                    </>}
                    <div className="sidebar-line" />
                    <button type="button" className="logout" onClick={() => { localStorage.removeItem('user'); navigate('/') }}>Logout</button>
                </aside>
                <main className="reservation-content">
                    <h1 className="clms-page-title reservation-manage-title">Reservations</h1>
                    <section className="glass-card reservation-management-card">
                        {isMISUser ? <div className="reservation-toolbar no-print"><label className="reservation-toolbar-label" htmlFor="mis-reservation-search">Search all reservation fields</label><input id="mis-reservation-search" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1) }} placeholder="Search laboratory, date, time, reserved by, role, status, note…" /><button type="button" className="reservation-refresh reservation-toolbar-button" onClick={toggleSelectAll} disabled={!filteredIds.length}>{allFilteredSelected ? 'Clear Selection' : 'Select All'}</button><button type="button" className="reservation-delete-all clms-delete-all reservation-toolbar-button" onClick={deleteReservations} disabled={!filteredIds.length}>{selectedIds.length ? `Delete Selected (${selectedIds.length})` : 'Delete All'}</button></div> : <>
                        <div className="card-title"><div><h3>Laboratory Reservations</h3></div><div className="reservation-title-actions" /></div>
                        <div className="reservation-search-row no-print"><label htmlFor="mis-reservation-search">Search all reservation fields</label><input id="mis-reservation-search" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1) }} placeholder="Search laboratory, date, time, reserved by, role, status, note…" /></div></>}
                        {loading ? <div className="reservation-empty">Loading reservations...</div> : reservations.length === 0 ? <div className="reservation-empty">No reservation records yet.</div> : (
                            <div className="reservation-table-wrap">
                                <table className="reservation-table reservation-requests-table">
                                    <thead><tr>{isMISUser && <th className="no-print"><input type="checkbox" aria-label="Select all listed reservations" checked={allFilteredSelected} onChange={toggleSelectAll} /></th>}<th>Laboratory</th><th>Reservation Date &amp; Time</th><th>Date Requested</th><th>Purpose / Subject</th><th>Reserved By</th><th>Status</th><th className="reservation-note-cell">Notes</th><th>Action</th></tr></thead>
                                    <tbody>{pageReservations.map(item => (
                                        <tr key={item.id}>
                                            {isMISUser && <td className="no-print"><input type="checkbox" aria-label={`Select reservation ${item.id}`} checked={selectedIds.includes(item.id)} onChange={() => toggleOne(item.id)} /></td>}
                                            <td>{item.laboratory_name || '—'}</td>
                                            <td>{formatDate(item.formatted_reservation_date || item.reservation_date)}<br/><small>{formatTime(item.start_time)} – {formatTime(item.end_time)}</small></td>
                                            <td className="reservation-requested-cell">{formatDateRequested(item.created_at)}</td>
                                            <td>{item.purpose || '—'}<br/><small>Subject: {item.subject_name || '—'}<br/>Professor: {item.professor_name || '—'}</small></td>
                                            <td>{item.reserved_by_role === 'MIS' ? 'System' : (item.reserved_by_name || '—')}<br/><small>{item.reserved_by_username ? `ID: ${item.reserved_by_username}` : ''}{item.reserved_by_program ? ` · ${item.reserved_by_program}` : ''}{roleLabel(item) !== '—' ? ` · ${roleLabel(item)}` : ''}</small></td>
                                            <td><span className={`reservation-status ${String(item.status).toLowerCase()}`}>{item.status}</span>{Number(item.holiday_flag) === 1 && <small className="holiday-flag" title={item.holiday_flag_note || ''}><br />Holiday conflict: {item.holiday_flag_note || 'date is now closed'}</small>}</td>
                                            <td className="reservation-note-cell">{item.cancellation_note || item.decision_note || '—'}</td>
                                            <td><div className="reservation-action-group">{item.status === 'PENDING' ? <><button type="button" className="reservation-action-button reservation-approve-button" onClick={() => handleDecision(item, 'APPROVED')}>Approve</button><button type="button" className="reservation-action-button reservation-cancel-button" onClick={() => handleDecision(item, 'DECLINED')}>Decline</button></> : item.status === 'APPROVED' ? <>{canUndoDecision(item) && <button type="button" className="reservation-action-button reservation-undo-button" title="Undo approval" aria-label="Undo approval" onClick={() => undoDecision(item)}>Undo</button>}{isMISUser && <button type="button" className="reservation-action-button reservation-cancel-button" onClick={() => openCancel(item)}>Cancel</button>}</> : item.status === 'DECLINED' && canUndoDecision(item) ? <button type="button" className="reservation-action-button reservation-undo-button" title="Undo decline" aria-label="Undo decline" onClick={() => undoDecision(item)}>Undo</button> : item.status === 'CANCELLED' && canUndoCancellation(item) ? <button type="button" className="reservation-action-button reservation-undo-button" onClick={() => undoCancellation(item)}>Undo cancellation</button> : <span className="reservation-muted">—</span>}</div></td>
                                        </tr>
                                    ))}{filteredReservations.length === 0 && <tr><td colSpan={isMISUser ? 9 : 8} className="reservation-empty">No reservations match your search.</td></tr>}</tbody>
                                </table>
                            </div>
                        )}
                        {!loading && filteredReservations.length > 0 && <PagePager className="reservation-pagination" ariaLabel="Reservation pagination" summary={`Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filteredReservations.length)} of ${filteredReservations.length}`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />}
                    </section>
                    
                </main>
            </div>


            {cancelling && (
                <div className="mis-cancel-backdrop" role="presentation">
                    <form className="mis-cancel-modal" role="dialog" aria-modal="true" onSubmit={handleCancelSubmit}>
                        <button type="button" className="mis-cancel-close" onClick={closeCancel} aria-label="Close">×</button>
                        <span>RESERVATION ACTION</span>
                        <h2>Cancel Reservation</h2>
                        <p>Cancel the approved reservation for <strong>{cancelling.laboratory_name}</strong> on <strong>{cancelling.formatted_reservation_date}</strong>?</p>
                        <label htmlFor="mis-cancellation-note">Cancellation Note <small>Required</small></label>
                        <textarea id="mis-cancellation-note" value={cancellationNote} onChange={event => setCancellationNote(event.target.value)} placeholder="Enter the reason for cancelling this reservation." maxLength={255} required />
                        <div className="mis-cancel-actions">
                            <button type="button" onClick={closeCancel}>Keep Reservation</button>
                            <button type="submit" disabled={!cancellationNote.trim()}>Confirm Cancellation</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    )
}

export default Reservations