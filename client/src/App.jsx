import { Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './components/AppLayout.jsx'
import MISDashboard from './pages/MISDashboard.jsx'
import Login from './pages/Login.jsx'
import Laboratories from './pages/Laboratories.jsx'
import Computers from './pages/Computers.jsx'
import Equipment from './pages/Equipment.jsx'
import Maintenance from './pages/Maintenance.jsx'
import Reservations from './pages/Reservations.jsx'
import MyReservations from './pages/MyReservations.jsx'
import InventoryDashboard from './pages/InventoryDashboard.jsx'
import InventorySchedule from './pages/InventorySchedule.jsx'
import TeacherDashboard from './pages/TeacherDashboard.jsx'
import ReportIssue from './pages/ReportIssue.jsx'
import DeanDashboard from './pages/DeanDashboard.jsx'
import ApprovedClasses from './pages/ApprovedClasses.jsx'
import Users from './pages/Users.jsx'
import Reports from './pages/Reports.jsx'
import AuditLog from './pages/AuditLog.jsx'
import ChangePassword from './pages/ChangePassword.jsx'
import RecycleBin from './pages/RecycleBin.jsx'
import Holidays from './pages/Holidays.jsx'
import TeacherSchedules from './pages/TeacherSchedules.jsx'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route element={<AppLayout />}>
        <Route path="/mis-dashboard" element={<MISDashboard />} />
        <Route path="/laboratories" element={<Laboratories />} />
        <Route path="/computers" element={<Computers />} />
        <Route path="/equipment" element={<Equipment />} />
        <Route path="/maintenance" element={<Maintenance />} />
        <Route path="/maintenance-history" element={<Maintenance historyOnlyRoute />} />
        <Route path="/reservations" element={<Reservations />} />
        <Route path="/my-reservations" element={<MyReservations />} />
        <Route path="/inventory-dashboard" element={<InventoryDashboard />} />
        <Route path="/inventory-schedule" element={<InventorySchedule />} />
        <Route path="/teacher-dashboard" element={<TeacherDashboard />} />
        <Route path="/report-issue" element={<ReportIssue />} />
        <Route path="/dean-dashboard" element={<DeanDashboard />} />
        <Route path="/approved-classes" element={<ApprovedClasses />} />
        <Route path="/users" element={<Users />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/holidays" element={<Holidays />} />
        <Route path="/teacher-schedules" element={<TeacherSchedules />} />
        <Route path="/recycle-bin" element={<RecycleBin />} />
        <Route path="/change-password" element={<ChangePassword />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
