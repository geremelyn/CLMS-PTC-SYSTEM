const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { undoRecordUpdate } = require('../utils/updateUndo.js')
// Undo of Laboratory / User edits (same user, no time limit, record unchanged since). MIS only, like those pages.
router.post('/record/:undoId', requireRole('MIS'), undoRecordUpdate)
module.exports = router
