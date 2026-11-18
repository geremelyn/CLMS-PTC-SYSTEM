import { useEffect, useMemo, useState } from 'react';
import api, { logoutSession } from '../api';
import { useNavigate } from 'react-router-dom';
import { customRoleName } from '../utils/roleDisplay.js';
import { formatDateRequested } from '../utils/reservationTime.js';
import './ApprovedClasses.css';

function ApprovedClasses() {
    const [reservations, setReservations] = useState([]);
    const [message, setMessage] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const navigate = useNavigate();
    const user = JSON.parse(localStorage.getItem('user') || 'null');

    useEffect(() => {
        getApprovedClasses();
        const refresh = () => { if (document.visibilityState === 'visible') getApprovedClasses(); };
        const timer = window.setInterval(refresh, 5000);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, []);

    async function getApprovedClasses() {
        setIsLoading(true);
        setMessage('');

        try {
            const response = await api.get('/reservations');
            const approvedReservations = (response.data.reservations || []).filter(
                (reservation) => reservation.status === 'APPROVED'
            );
            setReservations(approvedReservations);
        } catch (error) {
            console.error(
                'Unable to load approved classes:',
                error.response?.data?.message || error.message
            );
            setMessage('Unable to load approved classes. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }

    function formatTime(time) {
        if (!time) return '-';

        const [hour, minute] = time.split(':');
        const date = new Date();
        date.setHours(Number(hour), Number(minute), 0, 0);

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    }

    const approvedCountLabel = useMemo(() => {
        return `${reservations.length} ${reservations.length === 1 ? 'class' : 'classes'} approved`;
    }, [reservations.length]);

    const userInitial = user?.full_name?.trim()?.charAt(0)?.toUpperCase() || 'M';

    return (
        <div className="approved-classes-page">
            <div className="approved-classes-overlay" />

            <header className="approved-classes-header">
                <div className="approved-brand-section">
                    <div className="approved-brand-logo">
                        <img src="/clms-logo.png" alt="CLMS Logo" />
                    </div>
                    <div className="approved-brand-text">
                        <h1>CLMS</h1>
                        <span>Pateros Technological College</span>
                    </div>
                </div>

                <div className="approved-user-section">
                    <div className="approved-user-avatar" aria-hidden="true">
                        {userInitial}
                    </div>
                    <div className="approved-user-info">
                        <strong>{user?.full_name || 'Dean Staff'}</strong>
                        <span>{user?.role || 'Dean'}</span>
                    </div>
                </div>
            </header>

            <div className="approved-classes-content">
                <aside className="approved-sidebar">
                    <div className="approved-sidebar-title">MAIN MENU</div>

                    <button
                        type="button"
                        className="approved-nav-button"
                        onClick={() => navigate('/dean-dashboard')}
                    >
                        <span>Dashboard</span>
                    </button>

                    <button
                        type="button"
                        className="approved-nav-button approved-nav-button-active"
                        onClick={() => navigate('/approved-classes')}
                        aria-current="page"
                    >
                        <span>Approved Classes</span>
                    </button>

                    <button type="button" className="approved-nav-button" onClick={() => navigate('/reservations')}><span>Reserve Laboratory</span></button>
                    <button type="button" className="approved-nav-button" onClick={() => navigate('/my-reservations')}><span>My Reservations</span></button>
                    <button type="button" className="approved-nav-button" onClick={() => navigate('/reports')}><span>Reports</span></button>
                    <button type="button" className="approved-nav-button" onClick={() => navigate('/report-issue')}><span>Report Issue</span></button>
                    <button type="button" className="approved-nav-button" onClick={() => navigate('/change-password')}><span>Change Password</span></button>

                    <div className="approved-sidebar-divider" />

                    <button
                        type="button"
                        className="approved-nav-button approved-logout-button"
                        onClick={async () => {
                            await logoutSession()
                            navigate('/')
                        }}
                    >
                        <span>Logout</span>
                    </button>
                </aside>

                <main className="approved-classes-main">
                    <h1 className="clms-page-title">Approved Classes</h1>

                    <section className="approved-summary-row" aria-label="Approved class summary">
                        <div className="approved-summary-copy">
                            <strong>{approvedCountLabel}</strong>
                        </div>
                    </section>

                    {message && (
                        <div className="approved-feedback approved-feedback-error" role="alert">
                            <span className="approved-feedback-mark" aria-hidden="true">!</span>
                            <div>
                                <strong>Something went wrong</strong>
                                <p>{message}</p>
                            </div>
                            <button type="button" onClick={getApprovedClasses}>Retry</button>
                        </div>
                    )}

                    <section className="approved-table-panel" aria-label="Approved reservations">

                        {isLoading ? (
                            <div className="approved-loading-state" aria-live="polite">
                                <span className="approved-loading-bar approved-loading-bar-wide" />
                                <span className="approved-loading-bar" />
                                <span className="approved-loading-bar approved-loading-bar-short" />
                                <span className="approved-loading-label">Loading approved reservations...</span>
                            </div>
                        ) : reservations.length === 0 ? (
                            <div className="approved-empty-state">
                                <div className="approved-empty-mark" aria-hidden="true"> </div>
                                <h4>No approved classes yet</h4>
                                <p>Approved reservations will appear here once a request is cleared.</p>
                            </div>
                        ) : (
                            <div className="approved-table-scroll">
                                <table className="approved-reservations-table">
                                    <thead>
                                        <tr>
                                            <th>Laboratory</th>
                                            <th>Reserved by</th>
                                            <th>Role</th>
                                            <th>Date</th>
                                            <th>Time</th>
                                            <th>Date Requested</th>
                                            <th>Purpose / Subject</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {reservations.map((reservation) => (
                                            <tr key={reservation.id}>
                                                <td data-label="Laboratory">
                                                    <strong>{reservation.laboratory_name || 'Unnamed laboratory'}</strong>
                                                </td>
                                                <td data-label="Reserved by">{reservation.reserved_by_name || '-'}</td>
                                                <td data-label="Role">
                                                    <span className="approved-role-pill">{customRoleName(reservation.reserved_by_role, reservation.reserved_by_role_other) || reservation.reserved_by_role || '-'}</span>
                                                </td>
                                                <td data-label="Date">{reservation.formatted_reservation_date || '-'}</td>
                                                <td data-label="Time" className="approved-time-cell">
                                                    {formatTime(reservation.start_time)}
                                                    <span aria-hidden="true"> to </span>
                                                    {formatTime(reservation.end_time)}
                                                </td>
                                                <td data-label="Date Requested">{formatDateRequested(reservation.created_at)}</td>
                                                <td data-label="Purpose / Subject" className="approved-purpose-cell">
                                                    {reservation.purpose || 'Not specified'}
                                                </td>
                                                <td data-label="Status">
                                                    <span className="approved-status-pill">
                                                        <span className="approved-status-dot" aria-hidden="true" />
                                                        {reservation.status}
                                                    </span>
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
    );
}

export default ApprovedClasses;