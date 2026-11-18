const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { getMaintenance, createMaintenance, updateMaintenance, undoMaintenanceUpdate } = require('../controllers/maintenanceController.js')
const bulkActions = require('../controllers/bulkRecordController.js').createBulkRecordController('maintenance')
router.get('/', requireRole('MIS','Inventory Staff'), getMaintenance)
router.post('/', requireRole('Teacher','Dean','Others'), createMaintenance) // CP85: custom roles may submit issue reports
// CP57: delete selected / delete all (same roles that can already open and update Maintenance). Records go to the Recycle Bin.
router.post('/bulk-delete', requireRole('MIS', 'Inventory Staff'), bulkActions.bulkDelete)
router.post('/undo-bulk-delete/:undoId', requireRole('MIS', 'Inventory Staff'), bulkActions.undoDelete)
router.post('/undo/:undoId', requireRole('MIS', 'Inventory Staff'), undoMaintenanceUpdate)
router.put('/:id', requireRole('MIS', 'Inventory Staff'), updateMaintenance)
module.exports = router
