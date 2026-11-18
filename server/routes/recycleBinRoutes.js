const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { listRecycleBin, restoreRecycleItem, restoreRecycleItems, permanentDeleteRecycleItems } = require('../controllers/recycleBinController.js')
// MIS Super Admin only. Inventory Staff, Dean and Teacher are rejected with 403 by requireRole.
router.get('/', requireRole('MIS'), listRecycleBin)
router.post('/restore', requireRole('MIS'), restoreRecycleItems)
router.post('/permanent-delete', requireRole('MIS'), permanentDeleteRecycleItems)
router.post('/:id/restore', requireRole('MIS'), restoreRecycleItem)
module.exports = router
