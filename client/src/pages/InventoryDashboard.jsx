import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import MISPageShell from '../components/MISPageShell'
import { welcomeGreeting } from '../utils/roleDisplay.js'
import './InventoryDashboard.css'

function manilaToday() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${fields.year}-${fields.month}-${fields.day}`
}

export default function InventoryDashboard() {
    const navigate = useNavigate()
    let user = null
    try { user = JSON.parse(localStorage.getItem('user') || 'null') } catch { user = null }
    const [stats, setStats] = useState({ pendingReservations: 0, todayReservations: 0 })
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')

    useEffect(() => {
        if (user?.role !== 'Inventory Staff') { navigate('/', { replace: true }); return undefined }
        let cancelled = false
        async function loadStats() {
            try {
                const response = await api.get('/reservations')
                if (cancelled) return
                const reservations = response.data.reservations || []
                const today = manilaToday()
                setStats({
                    pendingReservations: reservations.filter(item => item.status === 'PENDING').length,
                    todayReservations: reservations.filter(item => String(item.reservation_date || item.formatted_reservation_date || '').slice(0, 10) === today && ['APPROVED', 'COMPLETED'].includes(item.status)).length,
                })
                setLoadError('')
            } catch (error) {
                if (!cancelled) setLoadError(error.response?.data?.message || 'Unable to load dashboard reservations.')
            } finally { if (!cancelled) setLoading(false) }
        }
        // Fetches API data; state updates follow the network response.
        loadStats()
        const timer = window.setInterval(() => { if (document.visibilityState === 'visible') loadStats() }, 10000)
        window.addEventListener('focus', loadStats)
        return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', loadStats) }
    }, [navigate, user?.role])

    if (user?.role !== 'Inventory Staff') return null
    const display = value => loading ? '—' : Number(value ?? 0).toLocaleString()
    return <MISPageShell active="dashboard" dashboardBackground>
        <section className="clean-role-dashboard clean-role-dashboard-standard inventory-role-dashboard compact-role-dashboard">
            <div className="inventory-dashboard-welcome compact-dashboard-card">
                <h1>{welcomeGreeting(user)}</h1>
                {loadError && <p className="dashboard-load-error" role="alert">{loadError}</p>}
                <div className="role-dashboard-stats compact-dashboard-stats">
                    <button type="button" onClick={() => navigate('/reservations')}><span>Pending Reservations</span><strong>{display(stats.pendingReservations)}</strong></button>
                    <button type="button" onClick={() => navigate('/reservations')}><span>Today's Reservations</span><strong>{display(stats.todayReservations)}</strong></button>
                </div>
            </div>
        </section>
    </MISPageShell>
}
