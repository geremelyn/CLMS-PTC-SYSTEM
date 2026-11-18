const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { listHolidays, createHoliday, updateHoliday, removeHoliday, generateDefaults } = require('../controllers/holidayController.js')
// Every signed-in role reads holidays (calendars show names and closed dates). Only MIS (Super Admin) manages them.
router.get('/', requireRole('MIS', 'Dean', 'Teacher', 'Inventory Staff', 'Others'), listHolidays)
router.post('/generate-defaults', requireRole('MIS'), generateDefaults)
router.post('/', requireRole('MIS'), createHoliday)
router.put('/:id', requireRole('MIS'), updateHoliday)
router.delete('/:id', requireRole('MIS'), removeHoliday)
module.exports = router
