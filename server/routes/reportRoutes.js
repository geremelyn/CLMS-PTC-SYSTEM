const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { getLaboratoryUsageReport, getReservationReport, getInventoryReport, getMaintenanceReport, getDamagedEquipmentReport, getUserAccountsReport, getAuditLogReport } = require('../controllers/reportController.js')
router.get('/laboratory-usage', requireRole('MIS'), getLaboratoryUsageReport)
router.get('/reservations', requireRole('MIS','Inventory Staff'), getReservationReport)
router.get('/inventory', requireRole('MIS','Inventory Staff'), getInventoryReport)
router.get('/maintenance', requireRole('MIS','Inventory Staff','Dean','Teacher','Others'), getMaintenanceReport) // Dean/Teacher/Others see ONLY their own reports
router.get('/damaged-equipment', requireRole('MIS','Inventory Staff'), getDamagedEquipmentReport)
router.get('/user-accounts', requireRole('MIS'), getUserAccountsReport)
router.get('/audit-log', requireRole('MIS'), getAuditLogReport)
module.exports = router
