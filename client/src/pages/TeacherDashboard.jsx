import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import MISPageShell from '../components/MISPageShell'
import { customRoleName, welcomeGreeting } from '../utils/roleDisplay.js'
import './TeacherDashboard.css'

export default function TeacherDashboard() {
    const navigate = useNavigate()
    let user = null
    try { user = JSON.parse(localStorage.getItem('user') || 'null') } catch { user = null }
    const [myReservations, setMyReservations] = useState(null)
    const [openLaboratories, setOpenLaboratories] = useState(null)
    const [loadError, setLoadError] = useState('')

    useEffect(() => {
        if (!['Teacher', 'Others'].includes(user?.role)) { navigate('/', { replace: true }); return undefined }
        let cancelled = false
        Promise.allSettled([api.get('/reservations'), api.get('/laboratories')]).then(results => {
            if (cancelled) return
            if (results[0].status === 'fulfilled') {
                const rows = results[0].value.data.reservations || []
                setMyReservations(rows.filter(row => Number(row.reserved_by) === Number(user?.id)).length)
            } else setLoadError('Unable to load your reservations.')
            if (results[1].status === 'fulfilled') {
                const labs = results[1].value.data.laboratories || []
                setOpenLaboratories(labs.filter(lab => String(lab.status).toUpperCase() === 'OPEN').length)
            } else setLoadError('Unable to load laboratory availability.')
        })
        return () => { cancelled = true }
    }, [navigate, user?.id, user?.role])

    if (!['Teacher', 'Others'].includes(user?.role)) return null
    const roleName = customRoleName(user?.role, user?.role_other) || 'Teacher'
    const count = value => value === null ? '—' : Number(value).toLocaleString()
    return <MISPageShell active="dashboard" dashboardBackground>
        {user?.must_change_password && <div className="password-required-backdrop" role="presentation"><section className="password-required-modal" role="dialog" aria-modal="true" aria-labelledby="required-password-title"><p className="clean-role-eyebrow">ACCOUNT SECURITY</p><h2 id="required-password-title">Change Password Required</h2><p>Please change your password before continuing to use the dashboard.</p><button type="button" onClick={() => navigate('/change-password?required=1')}>Next</button></section></div>}
        <section className="clean-role-dashboard teacher-dashboard compact-role-dashboard">
            <div className="teacher-dashboard-card compact-dashboard-card">
                {customRoleName(user?.role, user?.role_other) && <p className="clean-role-eyebrow">{roleName.toUpperCase()} DASHBOARD</p>}
                <h1>{welcomeGreeting(user)}</h1>
                {loadError && <p className="dashboard-load-error" role="alert">{loadError}</p>}
                <div className="role-dashboard-stats compact-dashboard-stats">
                    <button type="button" onClick={() => navigate('/my-reservations')}><span>My Reservations</span><strong>{count(myReservations)}</strong></button>
                    <button type="button" onClick={() => navigate('/reservations')}><span>Open Laboratories</span><strong>{count(openLaboratories)}</strong></button>
                </div>
            </div>
        </section>
    </MISPageShell>
}
