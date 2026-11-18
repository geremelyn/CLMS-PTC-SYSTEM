import { useEffect, useRef, useState } from 'react'
import api, { logoutSession } from '../api'
import { useClmsDialog } from '../components/ClmsDialog.jsx'
import { useNavigate } from 'react-router-dom'
import { getDefaultDashboard } from '../utils/dashboardRoutes.js'
import { customRoleName } from '../utils/roleDisplay.js'
import './ChangePassword.css'

function ChangePassword() {
    const navigate = useNavigate()
    const user = JSON.parse(localStorage.getItem('user'))

    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [message, setMessage] = useState('')
    const [messageType, setMessageType] = useState('')
    const { confirm } = useClmsDialog()
    const [loading, setLoading] = useState(false)
    const redirectTimer = useRef(null)
    useEffect(() => () => clearTimeout(redirectTimer.current), [])

    const role = user?.role || 'User'

    const dashboardPath = getDefaultDashboard(role, user?.role_other)

    function showMessage(text, type) {
        setMessage(text)
        setMessageType(type)
    }

    async function handleSubmit(event) {
        event.preventDefault()

        if (!currentPassword || !newPassword || !confirmPassword) {
            showMessage('Please complete all password fields.', 'error')
            return
        }

        if (newPassword !== confirmPassword) {
            showMessage('New passwords do not match.', 'error')
            return
        }

        if (newPassword.length < 6) {
            showMessage('New password must be at least 6 characters.', 'error')
            return
        }

        if (!await confirm('Change your password now?', { title: 'Change password', confirmLabel: 'Change password' })) return

        setLoading(true)
        setMessage('')

        try {
            const response = await api.put(
                `/users/${user.id}/change-password`,
                {
                    current_password: currentPassword,
                    new_password: newPassword
                }
            )

            const storedUser = JSON.parse(localStorage.getItem('user') || '{}')
            // A first-login (required) change: the flag was set on the stored session, or the page was opened with ?required=1.
            const wasRequired = Boolean(storedUser.must_change_password) || new URLSearchParams(window.location.search).get('required') === '1'
            localStorage.setItem('user', JSON.stringify({ ...storedUser, must_change_password: false }))
            // After a REQUIRED change, go straight to this role's default dashboard (shared resolver). Roles whose only
            // page is Change Password (custom "Others") stay put. The manual button below remains as a fallback.
            if (wasRequired && dashboardPath !== '/change-password') {
                clearTimeout(redirectTimer.current)
                redirectTimer.current = setTimeout(() => navigate(dashboardPath, { replace: true }), 1200)
            }
            showMessage(
                response.data.message || 'Password changed successfully.',
                'success'
            )

            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
        } catch (error) {
            showMessage(
                error.response?.data?.message ||
                    'Unable to change password.',
                'error'
            )
        } finally {
            setLoading(false)
        }
    }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    return (
        <div className="change-password-page">
            <div className="change-password-overlay" />

            <header className="change-password-header">
                <div className="change-password-brand">
                    <img src="/clms-logo.png" alt="CLMS Logo" />

                    <div>
                        <h1>CLMS</h1>
                        <span>Pateros Technological College</span>
                    </div>
                </div>

                <div className="change-password-user">
                    <div className="change-password-avatar">
                        {user?.full_name?.charAt(0)?.toUpperCase() || 'U'}
                    </div>

                    <div>
                        <strong>{user?.full_name || 'User'}</strong>
                        <span>{customRoleName(role, user?.role_other) || role}</span>
                    </div>
                </div>
            </header>

            <div className="change-password-layout">
                <aside className="change-password-sidebar">
                    <p>ACCOUNT</p>

                    <button
                        type="button"
                        onClick={() => navigate(dashboardPath)}
                    >
                        Dashboard
                    </button>

                    <button
                        type="button"
                        className="active"
                    >
                        Change Password
                    </button>

                    <div className="sidebar-line" />

                    <button
                        type="button"
                        className="logout"
                        onClick={handleLogout}
                    >
                        Logout
                    </button>
                </aside>

                <main className="change-password-content">
                    <h1 className="clms-page-title">Change Password</h1>
                    <section className="password-card">
                        <div className="password-card-header">
                            

                            <div>
                                <h3>Change Password</h3>
                            </div>
                        </div>

                        <form onSubmit={handleSubmit}>
                            <div className="password-field">
                                <label htmlFor="current-password">
                                    Current Password
                                </label>

                                <input
                                    id="current-password"
                                    type="password"
                                    value={currentPassword}
                                    onChange={event =>
                                        setCurrentPassword(event.target.value)
                                    }
                                    placeholder="Enter current password"
                                    autoComplete="current-password"
                                />
                            </div>

                            <div className="password-field">
                                <label htmlFor="new-password">
                                    New Password
                                </label>

                                <input
                                    id="new-password"
                                    type="password"
                                    value={newPassword}
                                    onChange={event =>
                                        setNewPassword(event.target.value)
                                    }
                                    placeholder="Enter new password"
                                    autoComplete="new-password"
                                />
                            </div>

                            <div className="password-field">
                                <label htmlFor="confirm-password">
                                    Confirm New Password
                                </label>

                                <input
                                    id="confirm-password"
                                    type="password"
                                    value={confirmPassword}
                                    onChange={event =>
                                        setConfirmPassword(event.target.value)
                                    }
                                    placeholder="Re-enter new password"
                                    autoComplete="new-password"
                                />
                            </div>

                            <div className="password-requirements">
                                <strong>Password requirements</strong>
                                <span>• At least 6 characters</span>
                                <span>• New passwords must match</span>
                                <span>• Only your own password can be changed</span>
                            </div>

                            {message && (
                                <div
                                    className={`password-message ${messageType}`}
                                >
                                    {message}
                                </div>
                            )}

                            <div className="password-actions">
                                {messageType === 'success' && new URLSearchParams(window.location.search).get('required') === '1' && <button type="button" className="primary-button" onClick={() => navigate(dashboardPath)}>Continue to Dashboard</button>}
                                <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() => navigate(dashboardPath)}
                                >
                                    Back
                                </button>

                                <button
                                    type="submit"
                                    className="primary-button"
                                    disabled={loading}
                                >
                                    {loading
                                        ? 'Updating...'
                                        : 'Change Password'}
                                </button>
                            </div>
                        </form>
                    </section>
                </main>
            </div>
        </div>
    )
}

export default ChangePassword