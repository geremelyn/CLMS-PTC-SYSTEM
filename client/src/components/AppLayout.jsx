import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { logoutSession } from '../api'
import './AppLayout.css'
import './ClmsTheme.css'
import { ClmsDialogProvider } from './ClmsDialog.jsx'
import { getDefaultDashboard } from '../utils/dashboardRoutes.js'

// A menu entry is [key, label, path] or { group, label, children: [[key, label, path], ...] } (collapsible dropdown).
const MENUS = {
  MIS: [
    ['dashboard', 'Dashboard', '/mis-dashboard'],
    ['reservations', 'Reservations', '/reservations'],
    { group: 'assets', label: 'Assets & Equipment', children: [
      ['labs', 'Laboratories', '/laboratories'],
      ['computers', 'Computers', '/computers'],
      ['equipment', 'Equipments', '/equipment'],
    ] },
    { group: 'maintenance', label: 'Maintenance', children: [
      ['maintenance', 'Maintenance', '/maintenance'],
      ['maintenance-history', 'Maintenance History', '/maintenance-history'],
    ] },
    { group: 'user-management', label: 'User Management', children: [
      ['users', 'User Accounts', '/users'],
      ['reports', 'Reports', '/reports'],
      ['audit', 'Audit Log', '/audit-log'],
      ['password', 'Change Password', '/change-password'],
      ['recycle-bin', 'Recycle Bin', '/recycle-bin'],
      ['holidays', 'Holidays', '/holidays'],
      ['teacher-schedules', 'Teacher Schedules', '/teacher-schedules'],
    ] },
  ],
  Teacher: [
    ['dashboard', 'Dashboard', '/teacher-dashboard'],
    ['reservations', 'Reserve Laboratory', '/reservations'],
    ['mine', 'My Reservations', '/my-reservations'],
    ['schedule', 'My Schedule', '/teacher-schedules'],
    ['report', 'Report Issue', '/report-issue'],
    ['reports', 'Reports', '/reports'],
    ['password', 'Change Password', '/change-password'],
  ],
  Dean: [
    ['dashboard', 'Dashboard', '/dean-dashboard'],
    ['reservations', 'Reserve Laboratory', '/reservations'],
    ['mine', 'My Reservations', '/my-reservations'],
    ['schedule', 'My Schedule', '/teacher-schedules'],
    ['report', 'Report Issue', '/report-issue'],
    ['reports', 'Reports', '/reports'],
    ['password', 'Change Password', '/change-password'],
  ],
  // Custom-role ("Others") accounts: lab reservation features only (same as Teacher minus Report Issue and Reports).
  Others: [
    ['dashboard', 'Dashboard', '/teacher-dashboard'],
    ['reservations', 'Reserve Laboratory', '/reservations'],
    ['mine', 'My Reservations', '/my-reservations'],
    ['schedule', 'My Schedule', '/teacher-schedules'],
    ['report', 'Report Issue', '/report-issue'],
    ['reports', 'My Reports', '/reports'],
    ['password', 'Change Password', '/change-password'],
  ],
  'Inventory Staff': [
    ['dashboard', 'Dashboard', '/inventory-dashboard'],
    ['reservations', 'Reservations', '/reservations'],
    { group: 'assets', label: 'Assets & Equipment', children: [
      ['computers', 'Computers', '/computers'],
      ['equipment', 'Equipments', '/equipment'],
    ] },
    { group: 'maintenance', label: 'Maintenance', children: [
      ['maintenance', 'Maintenance', '/maintenance'],
      ['maintenance-history', 'Maintenance History', '/maintenance-history'],
    ] },
    ['teacher-schedules', 'Teacher Schedules', '/teacher-schedules'],
    ['reports', 'Reports', '/reports'],
    ['password', 'Change Password', '/change-password'],
  ],
}

const flattenMenu = menu => menu.flatMap(entry => Array.isArray(entry) ? [entry] : entry.children)

function dashboardFor(role) {
  return getDefaultDashboard(role || 'Others') // Others / unknown roles: never fall back to Teacher pages (see utils/dashboardRoutes.js)
}

function activeKey(pathname, search, role) {
  if ((role === 'Inventory Staff' || role === 'MIS') && (pathname === '/maintenance-history' || (pathname === '/maintenance' && search.includes('view=history')))) return 'maintenance-history'
  const menu = flattenMenu(MENUS[role] || MENUS.Others)
  return menu.find(([, , path]) => pathname === path.split('?')[0])?.[0] || ''
}

const ROUTE_ACCESS = {
  MIS: ['/mis-dashboard','/users','/laboratories','/computers','/equipment','/reservations','/holidays','/maintenance','/maintenance-history','/reports','/audit-log','/recycle-bin','/teacher-schedules','/change-password'],
  Teacher: ['/teacher-dashboard','/reservations','/my-reservations','/teacher-schedules','/report-issue','/reports','/change-password'],
  Dean: ['/dean-dashboard','/reservations','/my-reservations','/teacher-schedules','/report-issue','/reports','/change-password'],
  Others: ['/teacher-dashboard','/reservations','/my-reservations','/teacher-schedules','/report-issue','/reports','/change-password'],
  'Inventory Staff': ['/inventory-dashboard','/reservations','/inventory-schedule','/computers','/equipment','/maintenance','/maintenance-history','/teacher-schedules','/reports','/change-password'],
}

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  // Collapsible sidebar groups: the group holding the current page opens automatically; the user can toggle any group.
  const [openGroups, setOpenGroups] = useState({})
  const user = (() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null }
  })()

  useEffect(() => {
    if (!user?.token) { navigate('/', { replace: true }); return }
    const allowed = ROUTE_ACCESS[user?.role] || []
    const passwordRequired = Boolean(user?.must_change_password) && ['Dean', 'Teacher', 'Others'].includes(user?.role)
    if (passwordRequired && location.pathname !== dashboardFor(user?.role) && location.pathname !== '/change-password') {
      navigate(dashboardFor(user?.role), { replace: true })
      return
    }
    if (!allowed.includes(location.pathname)) navigate(dashboardFor(user?.role), { replace: true })
  }, [navigate, user?.token, user?.role, user?.must_change_password, location.pathname])

  if (!user?.token) return null
  const role = user?.role || 'Others'
  if (!(ROUTE_ACCESS[role] || []).includes(location.pathname)) return null
  const items = MENUS[role] || MENUS.Others
  const active = activeKey(location.pathname, location.search, role)

  async function logout() {
    await logoutSession()
    navigate('/')
  }

  const roleClass = String(role).toLowerCase().replaceAll(' ', '-')
  const dashboardClass = location.pathname === '/mis-dashboard' || location.pathname === '/teacher-dashboard' || location.pathname === '/dean-dashboard' || location.pathname === '/inventory-dashboard'
    ? `clms-dashboard-${roleClass}` : ''

  return (
    <ClmsDialogProvider>
    <div className={`clms-app-shell clms-role-${roleClass} ${dashboardClass}`}>
      <header className="clms-header">
        <button type="button" className="clms-brand" onClick={() => navigate(dashboardFor(role))} aria-label="Go to dashboard">
          <span className="clms-brand-logo"><img src="/clms-logo.png" alt="CLMS" /></span>
          <span className="clms-brand-copy">
            <strong>CLMS</strong>
            <small>Pateros Technological College</small>
          </span>
        </button>

        <div className="clms-user-chip">
          <span className="clms-user-avatar">{user?.full_name?.charAt(0)?.toUpperCase() || 'U'}</span>
          <span className="clms-user-copy">
            <strong>{role === 'MIS' ? 'Super Admin' : (user?.full_name || (role === 'Inventory Staff' ? 'MIS Staff' : 'CLMS User'))}</strong>
            <small>{role === 'MIS' ? 'Super Admin (MIS Head)' : role === 'Inventory Staff' ? 'MIS Staff' : (role === 'Others' && user?.role_other) ? user.role_other : role}</small>
          </span>
        </div>
      </header>

      <div className="clms-layout">
        <aside className="clms-sidebar" aria-label="Main menu">
          <div className="clms-menu-title">MAIN MENU</div>
          <nav className="clms-menu">
            {items.map(entry => {
              if (Array.isArray(entry)) {
                const [key, label, path] = entry
                return <NavLink key={key} to={path} className={`clms-menu-item clms-menu-${key} ${active === key ? 'active' : ''}`}>
                  <span className="clms-menu-dot" />
                  <span>{label}</span>
                </NavLink>
              }
              const containsActive = entry.children.some(([key]) => key === active)
              const isOpen = openGroups[entry.group] ?? containsActive
              return <div key={entry.group} className={`clms-menu-dropdown${isOpen ? ' open' : ''}${containsActive ? ' has-active' : ''}`}>
                <button type="button" className="clms-menu-item clms-menu-toggle" aria-expanded={isOpen} aria-controls={`clms-group-${entry.group}`} onClick={() => setOpenGroups(current => ({ ...current, [entry.group]: !isOpen }))}>
                  <span className="clms-menu-dot" />
                  <span>{entry.label}</span>
                  <span className="clms-menu-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && <div className="clms-menu-sub" id={`clms-group-${entry.group}`}>
                  {entry.children.map(([key, label, path]) => <NavLink key={key} to={path} className={`clms-menu-item clms-menu-subitem clms-menu-${key} ${active === key ? 'active' : ''}`}>
                    <span className="clms-menu-dot" />
                    <span>{label}</span>
                  </NavLink>)}
                </div>}
              </div>
            })}
          </nav>

          <div className="clms-menu-divider" />
          <button type="button" className="clms-menu-item clms-logout" onClick={logout}>
            <span className="clms-menu-dot" />
            <span>Logout</span>
          </button>
        </aside>

        <main className="clms-main">
          <Outlet />
        </main>
      </div>

      <footer className="clms-footer">
        © 2026 Pateros Technological College · Computer Laboratory Monitoring System (CLMS)
      </footer>
    </div>
    </ClmsDialogProvider>
  )
}
