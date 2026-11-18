import { useCallback, useEffect, useState } from 'react'
import api from '../api'
import MISPageShell from '../components/MISPageShell'
import { welcomeGreeting } from '../utils/roleDisplay.js'
import './MISDashboard.css'

const EMPTY_STATS = { pendingReservations: 0, todayReservations: 0 }

export default function MISDashboard() {
    let user = null
    try { user = JSON.parse(localStorage.getItem('user') || 'null') } catch { user = null }
    const [stats, setStats] = useState(EMPTY_STATS)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')

    const loadStats = useCallback(async () => {
        try {
            const response = await api.get('/dashboard/mis')
            setStats({ ...EMPTY_STATS, ...(response.data.stats || {}) })
            setLoadError('')
        } catch (error) {
            setLoadError(error.response?.data?.message || 'Unable to load dashboard statistics. Check the API and database connection.')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (user?.role !== 'MIS') return undefined
        // Fetches external dashboard data; state updates happen when the request resolves.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadStats()
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') loadStats()
        }, 5000)
        window.addEventListener('focus', loadStats)
        return () => {
            window.clearInterval(timer)
            window.removeEventListener('focus', loadStats)
        }
    }, [loadStats, user?.role])

    if (user?.role !== 'MIS') return null

    const display = value => loading ? '—' : Number(value ?? 0).toLocaleString()
    return (
        <MISPageShell active="dashboard" dashboardBackground>
            <section className="clean-role-dashboard clean-role-dashboard-mis mis-role-dashboard compact-role-dashboard">
                <div className="mis-dashboard-welcome compact-dashboard-card">
                    <div className="mis-dashboard-copy">
                        <h1>{welcomeGreeting(user)}</h1>
                    </div>
                    {loadError && <p className="mis-dashboard-error" role="alert">{loadError}</p>}
                    <div className="mis-stat-row mis-stat-row-overview mis-stat-row-two" aria-label="Reservation overview">
                        <div className="mis-today-reservations"><span>Pending Reservations</span><strong>{display(stats.pendingReservations)}</strong></div>
                        <div className="mis-today-reservations"><span>Today's Reservations</span><strong>{display(stats.todayReservations)}</strong></div>
                    </div>
                </div>
            </section>
        </MISPageShell>
    )
}
