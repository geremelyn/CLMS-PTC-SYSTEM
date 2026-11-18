const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { listTeachers, listSchedules, uploadSchedule, deleteSchedule, undoUpload, downloadSchedule, viewSchedule } = require('../controllers/teacherScheduleController.js')
// CP121-CP123: Teacher, Dean and custom roles ('Others') upload/list/download their OWN schedules only (enforced in the controller).
// MIS Head / Super Admin uploads for any teacher and sees all; MIS Staff ('Inventory Staff') can only list/download all. CP128: DELETE /:id (MIS, Teacher, Dean, Others; own-only enforced in the controller) soft-deletes to the Recycle Bin. MIS Staff has no delete route.
router.get('/teachers', requireRole('MIS'), listTeachers)
router.get('/', requireRole('MIS', 'Inventory Staff', 'Teacher', 'Dean', 'Others'), listSchedules)
router.post('/', requireRole('MIS', 'Teacher', 'Dean', 'Others'), uploadSchedule)
router.post('/:id/undo-upload', requireRole('MIS', 'Teacher', 'Dean', 'Others'), undoUpload) // CP162: uploader-only, enforced in the controller
router.delete('/:id', requireRole('MIS', 'Teacher', 'Dean', 'Others'), deleteSchedule)
router.get('/:id/view', requireRole('MIS', 'Inventory Staff', 'Teacher', 'Dean', 'Others'), viewSchedule)
router.get('/:id/download', requireRole('MIS', 'Inventory Staff', 'Teacher', 'Dean', 'Others'), downloadSchedule)
module.exports = router
