import { useEffect, useState } from 'react'
import PagePager from '../components/PagePager.jsx'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx'
import api, { logoutSession } from '../api'
import { useNavigate } from 'react-router-dom'
import { sortMyReservations, visibleOwnReservations, canUndoReservationCreation } from '../utils/reservationSorting.mjs'
import { customRoleName } from '../utils/roleDisplay.js'
import { formatDateRequested } from '../utils/reservationTime.js'
import './MyReservations.css'

function MyReservations() {
    const navigate = useNavigate()
    const { confirm } = useClmsDialog()
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null } })()

    const [reservations, setReservations] = useState([])
    const [loadingReservations, setLoadingReservations] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [isCancelling, setIsCancelling] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page; typed page number + Previous / Next
    const [cancellingReservation, setCancellingReservation] = useState(null)
    const [cancellationReason, setCancellationReason] = useState('')
    const [message, setMessage] = useState('')
    const [messageType, setMessageType] = useState('')
    useCenteredFeedback(message, messageType, () => setMessage(''))

    async function getReservations() {
        setLoadingReservations(true)
        setLoadError('')
        try {
            const response = await api.get('/reservations')
            const ownReservations = visibleOwnReservations((response.data.reservations || []).filter(
                reservation => Number(reservation.reserved_by) === Number(user?.id)
            ))
            setReservations(sortMyReservations(ownReservations))
            setCurrentPage(1)
        } catch (error) {
            console.error('Unable to load reservations:', error.response?.data?.message || error.message)
            setLoadError(error.response?.data?.message || 'Unable to load your reservations. Check your connection and try again.')
        } finally {
            setLoadingReservations(false)
        }
    }

    useEffect(() => {
        // This effect intentionally starts an API fetch; state updates occur when the request resolves.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        getReservations()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / selected filter changes
    }, [])

    function showMessage(text, type = 'success') {
        setMessage(text)
        setMessageType(type)
    }

    function formatTime(time) {
        if (!time) return '-'

        const [hour, minute] = time.split(':')
        const date = new Date()
        date.setHours(Number(hour), Number(minute), 0, 0)

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        })
    }

    function formatStatus(status) {
        return status?.replaceAll('_', ' ') || '-'
    }

    function getTimeRange(reservation) {
        return `${formatTime(reservation.start_time)} - ${formatTime(reservation.end_time)}`
    }

    const search = searchTerm.trim().toLowerCase()
    const filteredReservations = reservations.filter(reservation => !search || [reservation.laboratory_name, reservation.purpose, reservation.subject_name, reservation.professor_name, reservation.formatted_reservation_date, reservation.reservation_date, reservation.start_time, reservation.end_time, reservation.status, reservation.cancellation_note, reservation.reserved_by_name, reservation.reserved_by_role].some(value => String(value ?? '').toLowerCase().includes(search)))
    // Newest submissions first, COMPLETED last (sorted before paging so page 1 holds the top of the list).
    const sortedReservations = sortMyReservations(filteredReservations)
    const totalPages = Math.max(1, Math.ceil(filteredReservations.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const canUndoCreation = canUndoReservationCreation

    async function undoCreation(reservation) {
        if (!await confirm('Undo creation of this reservation? It will be removed only if it has not been processed yet.')) return
        try {
            const response = await api.put(`/reservations/${reservation.id}/undo-create`)
            showMessage(response.data.message || 'Reservation creation undone.', 'success')
            await getReservations()
        } catch (error) {
            showMessage(error.response?.data?.message || 'Unable to undo reservation creation.', 'error')
        }
    }

    const pageReservations = sortedReservations.slice((safePage - 1) * pageSize, safePage * pageSize)

    function openCancellation(reservation) {
        setCancellingReservation(reservation)
        setCancellationReason('')
    }

    function closeCancellation() {
        setCancellingReservation(null)
        setCancellationReason('')
    }

    async function submitCancellation(event) {
        event.preventDefault()

        if (isCancelling) return
        if (!cancellationReason.trim()) {
            showMessage('Please enter a cancellation reason', 'error')
            return
        }

        if (!await confirm('Confirm cancellation of this reservation?', { title: 'Cancel reservation', confirmLabel: 'Confirm' })) return
        setIsCancelling(true)
        try {
            const response = await api.put(
                `/reservations/${cancellingReservation.id}/cancel`,
                {
                    user_id: user.id,
                    cancellation_note: cancellationReason.trim()
                }
            )

            showMessage(response.data.message, 'success')
            closeCancellation()
            await getReservations()
        } catch (error) {
            showMessage(
                error.response?.data?.message || 'Unable to cancel reservation',
                'error'
            )
        } finally {
            setIsCancelling(false)
        }
    }

    function clearFilters() { setSearchTerm(''); setCurrentPage(1); getReservations() }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    return (
        <div className="my-reservations-page">
            <div className="my-reservations-overlay" />

            <header className="my-reservations-header">
                <div className="my-reservations-brand">
                    <img src="/clms-logo.png" alt="CLMS Logo" />
                    <div>
                        <h1>CLMS</h1>
                        <span>Pateros Technological College</span>
                    </div>
                </div>

                <div className="my-reservations-user">
                    <div className="my-reservations-avatar" aria-hidden="true">
                        {user?.full_name?.trim()?.charAt(0)?.toUpperCase() || 'U'}
                    </div>
                    <div className="my-reservations-user-info">
                        <strong>{user?.full_name || 'User'}</strong>
                        <span>{customRoleName(user?.role, user?.role_other) || (user?.role === 'Inventory Staff' ? 'MIS Staff' : user?.role || 'User')}</span>
                    </div>
                </div>
            </header>

            <div className="my-reservations-layout">
                <aside className="my-reservations-sidebar">
                    <p>MAIN MENU</p>

                    <button type="button" onClick={() => navigate(user?.role === 'Dean' ? '/dean-dashboard' : '/teacher-dashboard')}>
                        <span aria-hidden="true"> </span>
                        Dashboard
                    </button>

                    <button type="button" onClick={() => navigate('/reservations')}>
                        <span aria-hidden="true"> </span>
                        Reserve Laboratory
                    </button>

                    <button type="button" className="active" aria-current="page">
                        <span aria-hidden="true"> </span>
                        My Reservations
                    </button>

                    {user?.role === 'Teacher' || user?.role === 'Others' ? (
                        <button type="button" onClick={() => navigate('/report-issue')}>
                            <span aria-hidden="true"> </span>
                            Report Issue
                        </button>
                    ) : null}

                    {user?.role === 'Dean' && (
                        <button type="button" onClick={() => navigate('/report-issue')}>
                            <span aria-hidden="true"> </span>
                            Report Issue
                        </button>
                    )}

                    {<button type="button" onClick={() => navigate('/reports')}>
                        <span aria-hidden="true"> </span>
                        Reports
                    </button>}
                    <button type="button" onClick={() => navigate('/change-password')}>
                        <span aria-hidden="true"> </span>
                        Change Password
                    </button>

                    <div className="my-reservations-sidebar-line" />

                    <button type="button" className="logout" onClick={handleLogout}>
                        <span aria-hidden="true"> </span>
                        Logout
                    </button>
                </aside>

                <main className="my-reservations-content">
                    <section className="my-reservations-heading">
                        <h1>My Reservations</h1>
                        {!['Dean', 'Teacher'].includes(user?.role) && <p>Review your laboratory bookings, status, and cancellation history.</p>}{/* CP92: intro sentence removed for Dean and Teacher */}
                    </section>

                    <section className="my-reservations-card results-card">
                        <div className="my-reservations-card-title my-reservations-search-title">
                            <div className="my-reservations-toolbar">
                                <input id="my-reservations-search" aria-label="Search reservations" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1) }} placeholder="Search laboratory, date, time, purpose, status, note…" />
                                <strong className="reservation-count">{filteredReservations.length} {filteredReservations.length === 1 ? 'booking' : 'bookings'}</strong>
                            </div>
                        </div>

                        <div className="my-reservations-table-container">
                            <table className="my-reservations-table">
                                <thead><tr><th>Laboratory</th><th>Reservation Date &amp; Time</th><th>Date Requested</th><th>Purpose / Subject</th><th>Status</th><th>Action</th></tr></thead>
                                <tbody>
                                    {loadingReservations ? (
                                        <tr><td colSpan="6" className="my-reservations-empty">Loading your reservations…</td></tr>
                                    ) : loadError ? (
                                        <tr><td colSpan="6" className="my-reservations-empty"><span role="alert">{loadError}</span> <button type="button" onClick={getReservations}>Try Again</button></td></tr>
                                    ) : filteredReservations.length > 0 ? (
                                        pageReservations.map(reservation => (
                                            <tr key={reservation.id}>
                                                <td className="reservation-laboratory">{reservation.laboratory_name}</td>
                                                <td>{reservation.formatted_reservation_date}<br/><small>{getTimeRange(reservation)}</small></td>
                                                <td>{formatDateRequested(reservation.created_at)}</td>
                                                <td className="reservation-purpose">{reservation.purpose || '—'}<br/><small>Subject: {reservation.subject_name || '—'}<br/>Professor: {reservation.professor_name || '—'}</small></td>
                                                <td>
                                                    <span className={`reservation-status ${reservation.status?.toLowerCase()}`}>
                                                        {formatStatus(reservation.status)}
                                                    </span>
                                                    {Number(reservation.holiday_flag) === 1 && (
                                                        <p className="reservation-cancel-note" style={{ background: '#fff1d9', color: '#8a5a00', borderRadius: 8, padding: '6px 8px' }}>
                                                            <strong>⚑ Holiday conflict:</strong> {reservation.holiday_flag_note || 'This date is now closed. Please reschedule or cancel.'}
                                                        </p>
                                                    )}
                                                    {reservation.status === 'CANCELLED' && reservation.cancellation_note && (
                                                        <p className="reservation-cancel-note reservation-cancel-note-centered">
                                                            <strong>Note:</strong> {reservation.cancellation_note}
                                                        </p>
                                                    )}
                                                </td>
                                                <td>
                                                    {canUndoCreation(reservation) ? (
                                                        <button type="button" className="reservation-cancel-button" onClick={() => undoCreation(reservation)}>Undo creation</button>
                                                    ) : reservation.status === 'APPROVED' && (
                                                        <button
                                                            type="button"
                                                            className="reservation-cancel-button"
                                                            onClick={() => openCancellation(reservation)}
                                                        >
                                                            Cancel
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan="6" className="my-reservations-empty">
                                                No reservations match your filters.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        {!loadingReservations && !loadError && filteredReservations.length > 0 && <PagePager className="my-reservations-pagination" ariaLabel="My reservations pagination" summary={`Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filteredReservations.length)} of ${filteredReservations.length}`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />}
                    </section>
                </main>
            </div>

            {cancellingReservation && (
                <div className="my-reservations-modal-bg" role="presentation">
                    <div className="my-reservations-modal" role="dialog" aria-modal="true" aria-labelledby="my-reservations-cancel-title">
                        <button type="button" className="my-reservations-close-modal" aria-label="Close cancellation dialog" onClick={closeCancellation} disabled={isCancelling}>
                            x
                        </button>

                        <span>CANCELLATION</span>
                        <h2 id="my-reservations-cancel-title">Cancel Reservation</h2>

                        <div className="my-reservations-summary">
                            <p><strong>Laboratory:</strong> {cancellingReservation.laboratory_name}</p>
                            <p><strong>Date:</strong> {cancellingReservation.formatted_reservation_date}</p>
                            <p>
                                <strong>Time:</strong> {formatTime(cancellingReservation.start_time)} - {formatTime(cancellingReservation.end_time)}
                            </p>
                            <p><strong>Purpose:</strong> {cancellingReservation.purpose}</p>
                        </div>

                        <form onSubmit={submitCancellation}>
                            <label htmlFor="cancellation-note">Cancellation Note </label>
                            <textarea
                                id="cancellation-note"
                                value={cancellationReason}
                                onChange={event => setCancellationReason(event.target.value)}
                                placeholder="Why was the reservation cancelled? (e.g., class suspended, schedule conflict)"
                                maxLength={255}
                                required
                            />
                            <small className="my-reservations-note-count">{cancellationReason.length}/255</small>

                            <p className="my-reservations-cancel-warning">This will cancel your own reservation. The reservation will remain in history.</p>

                            <div className="my-reservations-modal-buttons">
                                <button type="submit" className="my-reservations-confirm-button" disabled={isCancelling}>
                                    {isCancelling ? 'Cancelling…' : 'Confirm Cancellation'}
                                </button>
                                <button type="button" className="my-reservations-cancel-button" onClick={closeCancellation} disabled={isCancelling}>
                                    Keep Reservation
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    )
}

export default MyReservations