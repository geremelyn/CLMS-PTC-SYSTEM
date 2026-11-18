const ROLES = {
    MIS: 'MIS',
    DEAN: 'Dean',
    TEACHER: 'Teacher',
    INVENTORY: 'Inventory Staff'
}

function getCurrentUser() {
    try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null }
}
function getCurrentRole() { return getCurrentUser()?.role || null }
function isMIS() { return getCurrentRole() === ROLES.MIS }
function isDean() { return getCurrentRole() === ROLES.DEAN }
function isTeacher() { return getCurrentRole() === ROLES.TEACHER }
function isInventory() { return getCurrentRole() === ROLES.INVENTORY }
function canCreateReservation() { return [ROLES.MIS, ROLES.DEAN, ROLES.TEACHER].includes(getCurrentRole()) }
function canCancelAnyReservation() { return isMIS() }
function canCancelOwnReservation() { return [ROLES.MIS, ROLES.DEAN, ROLES.TEACHER].includes(getCurrentRole()) }
function canViewAuditLogs() { return isMIS() }
function canManageUsers() { return isMIS() }
function canManageComputers() { return isMIS() }
function canManageEquipment() { return isMIS() || isInventory() }
function canProcessMaintenance() { return isInventory() }
function canReportMaintenance() { return isTeacher() }
module.exports = { ROLES, getCurrentUser, getCurrentRole, isMIS, isDean, isTeacher, isInventory, canCreateReservation, canCancelAnyReservation, canCancelOwnReservation, canViewAuditLogs, canManageUsers, canManageComputers, canManageEquipment, canProcessMaintenance, canReportMaintenance }
