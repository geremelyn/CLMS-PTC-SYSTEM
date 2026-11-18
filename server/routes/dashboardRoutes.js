const express = require('express')
const { getTotalUsers, getMISStats } = require('../controllers/dashboardController.js')
const { requireRole } = require('../middleware/roleAuth.js')
const router = express.Router()
router.get('/users/count', requireRole('MIS'), getTotalUsers)
router.get('/mis', requireRole('MIS'), getMISStats)
module.exports = router
