const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { getAuditLogs } = require('../controllers/auditLogController.js')
router.get('/', requireRole('MIS'), getAuditLogs)
module.exports = router
