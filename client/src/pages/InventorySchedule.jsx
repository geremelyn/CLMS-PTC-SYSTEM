import DatePicker from '../components/DatePicker.jsx'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { logoutSession } from '../api'
import './InventoryDashboard.css'
import { manilaToday, manilaClock } from '../utils/manilaTime'
import { useHolidayMap } from '../utils/holidays'
import './InventorySchedule.css'

const API = ''

function getTodayLocal() { return manilaToday() }

function getUser() {
    try {
        return JSON.parse(localStorage.getItem('user')) || {}
    } catch {
        return {}
    }
}

function formatTime(time) {
    if (!time) return '-'

    const [hour, minute] = String(time).slice(0, 5).split(':')
    const date = new Date()
    date.setHours(Number(hour), Number(minute), 0, 0)

    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    })
}

function formatDateLabel(value) {
    if (!value) return 'Select a date'

    return new Date(`${value}T00:00:00`).toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    })
}

function normalizeDate(value) {
    if (!value) return ''
    return String(value).slice(0, 10)
}

function statusClass(status) {
    return status.toLowerCase().replaceAll(' ', '-')
}

function InventorySchedule() {
    const navigate = useNavigate()
    const user = getUser()
    const [laboratories, setLaboratories] = useState([])
    const [reservations, setReservations] = useState([])
    const [laboratoryId, setLaboratoryId] = useState('')
    const [scheduleDate, setScheduleDate] = useState(getTodayLocal())
    const { map: holidayMap } = useHolidayMap([Number(String(scheduleDate || getTodayLocal()).slice(0, 4))])
    const dayHoliday = holidayMap.get(scheduleDate)
    const dayNote = dayHoliday ? `${dayHoliday.name} - ${dayHoliday.type_label}${dayHoliday.blocks_reservations ? ' (closed for reservations)' : ' (open for reservations)'}` : (new Date(`${scheduleDate}T00:00:00Z`).getUTCDay() === 0 ? 'Sunday (closed for reservations)' : '')
    const [isLoading, setIsLoading] = useState(true)
    const [message, setMessage] = useState('')

    useEffect(() => {
        if (!message) return undefined

        const timer = setTimeout(() => setMessage(''), 4500)
        return () => clearTimeout(timer)
    }, [message])

    async function loadScheduleData() {
        setIsLoading(true)

        await Promise.all([
            loadLaboratories(),
            loadReservations()
        ])

        setIsLoading(false)
    }


    async function loadLaboratories() {
        try {
            const response = await api.get(`${API}/laboratories`)
            const nextLaboratories = response.data.laboratories || []
            setLaboratories(nextLaboratories)
            if (nextLaboratories.length) setLaboratoryId(current => current || String(nextLaboratories[0].id))
        } catch (error) {
            setMessage(
                error.response?.data?.message ||
                'Unable to load laboratories'
            )
        }
    }

    async function loadReservations() {
        try {
            const response = await api.get(`${API}/reservations`)
            setReservations(response.data.reservations || [])
        } catch (error) {
            setMessage(
                error.response?.data?.message ||
                'Unable to load reservations'
            )
        }
    }

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- start async API data loading on mount
        loadScheduleData()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initial data load
    }, [])

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    const selectedLaboratory = laboratories.find(
        (laboratory) => Number(laboratory.id) === Number(laboratoryId)
    )

    const timeSlots = useMemo(() => {
        if (
            !selectedLaboratory?.available_from ||
            !selectedLaboratory?.available_until ||
            !selectedLaboratory?.booking_interval
        ) {
            return []
        }

        const [startHour, startMinute] = selectedLaboratory.available_from
            .split(':')
            .map(Number)
        const [endHour, endMinute] = selectedLaboratory.available_until
            .split(':')
            .map(Number)
        const interval = Number(selectedLaboratory.booking_interval)
        const slots = []
        let currentMinutes = startHour * 60 + startMinute
        const endMinutes = endHour * 60 + endMinute

        if (!interval || interval <= 0) return []

        while (currentMinutes + interval <= endMinutes) {
            const nextMinutes = currentMinutes + interval
            const startHours = Math.floor(currentMinutes / 60)
            const startMins = currentMinutes % 60
            const endHours = Math.floor(nextMinutes / 60)
            const endMins = nextMinutes % 60

            slots.push({
                start_time: `${String(startHours).padStart(2, '0')}:${String(startMins).padStart(2, '0')}`,
                end_time: `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`
            })

            currentMinutes = nextMinutes
        }

        return slots
    }, [selectedLaboratory])

    function getReservationForSlot(slot) {
        if (!laboratoryId || !scheduleDate) return null

        return reservations.find((reservation) => {
            if (reservation.status === 'CANCELLED') return false

            const sameLaboratory =
                Number(reservation.laboratory_id) === Number(laboratoryId)
            const reservationDate = normalizeDate(
                reservation.formatted_reservation_date ||
                reservation.reservation_date ||
                reservation.date
            )
            const sameDate = reservationDate === scheduleDate
            const reservationStart = String(reservation.start_time || '').slice(0, 5)
            const reservationEnd = String(reservation.end_time || '').slice(0, 5)
            const overlaps =
                slot.start_time < reservationEnd &&
                slot.end_time > reservationStart

            return sameLaboratory && sameDate && overlaps
        })
    }

    function getSlotStatus(reservation) {
        if (!reservation) return 'Available'
        if (scheduleDate !== getTodayLocal()) return 'Reserved'

        const currentTime = manilaClock()
        const startTime = String(reservation.start_time || '').slice(0, 5)
        const endTime = String(reservation.end_time || '').slice(0, 5)

        return currentTime >= startTime && currentTime < endTime
            ? 'Occupied'
            : 'Reserved'
    }

    const scheduleRows = timeSlots.map((slot) => {
        const reservation = getReservationForSlot(slot)
        const status = getSlotStatus(reservation)

        return { slot, reservation, status }
    })

    const reservedCount = scheduleRows.filter(
        (row) => row.status !== 'Available'
    ).length
    const availableCount = scheduleRows.length - reservedCount

    return (
        <div className="schedule-page">
            <div className="schedule-overlay" />

            <header className="schedule-header">
                <button
                    className="schedule-brand"
                    type="button"
                    onClick={() => navigate('/inventory-dashboard')}
                >
                    <span className="schedule-brand-logo">
                        <img src="/clms-logo.png" alt="CLMS Logo" />
                    </span>
                    <span>
                        <strong>CLMS</strong>
                        <small>Pateros Technological College</small>
                    </span>
                </button>

                <div className="schedule-user">
                    <span className="schedule-avatar">
                        {user.full_name?.charAt(0)?.toUpperCase() || 'I'}
                    </span>
                    <span className="schedule-user-info">
                        <strong>{user.full_name || 'MIS Staff'}</strong>
                        <small>MIS Staff</small>
                    </span>
                </div>
            </header>

            <div className="schedule-layout">
                <aside className="schedule-sidebar">
                    <div className="schedule-sidebar-title">MAIN MENU</div>

                    <button
                        type="button"
                        className="schedule-nav-button"
                        onClick={() => navigate('/inventory-dashboard')}
                    >
                        Dashboard
                    </button>
                    <button
                        type="button"
                        className="schedule-nav-button"
                        onClick={() => navigate('/equipment')}
                    >
                        Equipment
                    </button>
                    <button
                        type="button"
                        className="schedule-nav-button"
                        onClick={() => navigate('/maintenance')}
                    >
                        Maintenance
                    </button>
                    <button
                        type="button"
                        className="schedule-nav-button active"
                    >
                        Laboratory Schedule
                    </button>

                    <div className="schedule-sidebar-divider" />

                    <button
                        type="button"
                        className="schedule-nav-button logout"
                        onClick={handleLogout}
                    >
                        Logout
                    </button>
                </aside>

                <main className="schedule-main">
                    <section className="schedule-heading">
                        <h1>Laboratory Schedule</h1>
                    </section>

                    {message && (
                        <div className="schedule-alert" role="status">
                            {message}
                        </div>
                    )}

                    <section className="schedule-controls">
                        <label>
                            <span>Laboratory</span>
                            <select
                                value={laboratoryId}
                                onChange={(event) =>
                                    setLaboratoryId(event.target.value)
                                }
                                disabled={isLoading || laboratories.length === 0}
                            >
                                {laboratories.length === 0 && (
                                    <option value="">No laboratories available</option>
                                )}
                                {laboratories.map((laboratory) => (
                                    <option
                                        key={laboratory.id}
                                        value={laboratory.id}
                                    >
                                        {laboratory.laboratory_name || laboratory.name}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label>
                            <span>Date</span>
                            <DatePicker restrictDays={false} title="Schedule date" value={scheduleDate} onChange={setScheduleDate} />
                        </label>
                    </section>

                    <section className="schedule-summary">
                        <div className="schedule-summary-copy">
                            <p className="schedule-eyebrow">DAILY VIEW</p>
                            <h2>{formatDateLabel(scheduleDate)}</h2>
                            {dayNote && <p className="schedule-holiday-note"><strong>{dayNote}</strong></p>}
                            <p>
                                {selectedLaboratory?.laboratory_name ||
                                    'Select a laboratory'}
                            </p>
                        </div>
                        <div className="schedule-summary-stats">
                            <div>
                                <span>Available slots</span>
                                <strong>{availableCount}</strong>
                            </div>
                            <div>
                                <span>Reserved slots</span>
                                <strong>{reservedCount}</strong>
                            </div>
                        </div>
                    </section>

                    <section className="schedule-panel">
                        <div className="schedule-panel-heading">
                            <div>
                                <p className="schedule-eyebrow">TIME BLOCKS</p>
                                <h2>Daily schedule</h2>
                            </div>
                            <div className="schedule-legend">
                                <span><i className="available" /> Available</span>
                                <span><i className="reserved" /> Reserved</span>
                                <span><i className="occupied" /> Occupied</span>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="schedule-empty">
                                Loading laboratory schedule...
                            </div>
                        ) : !selectedLaboratory ? (
                            <div className="schedule-empty">
                                Select a laboratory to view its schedule.
                            </div>
                        ) : timeSlots.length === 0 ? (
                            <div className="schedule-empty">
                                This laboratory does not have a booking schedule configured.
                            </div>
                        ) : (
                            <div className="schedule-table-wrap">
                                <table className="schedule-table">
                                    <thead>
                                        <tr>
                                            <th>Time</th>
                                            <th>Scheduled activity</th>
                                            <th>Status</th>
                                            <th>Teacher / requester</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {scheduleRows.map(({ slot, reservation, status }) => (
                                            <tr key={`${slot.start_time}-${slot.end_time}`}>
                                                <td>
                                                    <strong>
                                                        {formatTime(slot.start_time)}
                                                    </strong>
                                                    <small>
                                                        {formatTime(slot.end_time)}
                                                    </small>
                                                </td>
                                                <td>
                                                    {reservation?.purpose || (
                                                        <span className="schedule-muted">
                                                            No reservation
                                                        </span>
                                                    )}
                                                </td>
                                                <td>
                                                    <span
                                                        className={`schedule-status ${statusClass(
                                                            status
                                                        )}`}
                                                    >
                                                        {status}
                                                    </span>
                                                </td>
                                                <td>
                                                    {reservation?.reserved_by_name || (
                                                        <span className="schedule-muted">
                                                            -
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </main>
            </div>

        </div>
    )
}

export default InventorySchedule