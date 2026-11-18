const express = require('express')
const { login, logout } = require('../controllers/authController.js')
const { requireRole } = require('../middleware/roleAuth.js')

const router = express.Router()
router.post('/login', login)
router.post('/logout', requireRole('MIS', 'Dean', 'Teacher', 'Inventory Staff', 'Others'), logout)
module.exports = router
