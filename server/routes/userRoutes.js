const express = require('express')
const router = express.Router()
const { withUpdateUndo } = require('../utils/updateUndo.js')
const simpleImport = require('../controllers/simpleImportController.js').createSimpleImportController('users')
const { requireRole } = require('../middleware/roleAuth.js')
const { getUsers, createUser, updateUser, resetPassword, setUserStatus, changeOwnPassword, getCustomRoles, deleteCustomRole } = require('../controllers/userController.js')
router.get('/', requireRole('MIS'), getUsers)
// CP118: custom roles (MIS only). Built-in roles cannot be deleted; a custom role still assigned to accounts cannot be deleted.
router.get('/custom-roles', requireRole('MIS'), getCustomRoles)
router.delete('/custom-roles/:ref', requireRole('MIS'), deleteCustomRole)
router.get('/import-template', requireRole('MIS'), require('../controllers/importTemplateController.js').createImportTemplateController('users'))
router.post('/import-preview', requireRole('MIS'), (req, res, next) => { if (!req.body?.fileBase64) return res.status(400).json({ message: 'Choose a valid .xlsx file (maximum 5 MB).' }); return simpleImport.preview(req, res, next) })
router.post('/import', requireRole('MIS'), simpleImport.commit)
const { deleteUsers } = require('../controllers/recycleBinController.js')
router.post('/export', requireRole('MIS'), require('../controllers/dataExportController.js').createDataExportController('users'))
// Deleting moves accounts to the MIS-only Recycle Bin; accounts that are in use are refused with a reason.
router.post('/bulk-delete', requireRole('MIS'), deleteUsers)
router.post('/', requireRole('MIS'), createUser)
router.put('/:id', requireRole('MIS'), withUpdateUndo('users'), updateUser)
router.delete('/:id', requireRole('MIS'), (request, response) => { request.body = { ids: [Number(request.params.id)] }; return deleteUsers(request, response) })
router.put('/:id/reset-password', requireRole('MIS'), resetPassword)
router.put('/:id/status', requireRole('MIS'), setUserStatus)
// SELF-SERVICE ONLY: 'Others' (custom-role) accounts may change their OWN password here and nowhere else.
router.put('/:id/change-password', requireRole('MIS','Dean','Teacher','Inventory Staff','Others'), (request, response, next) => {
    if (Number(request.params.id) !== Number(request.user.id)) return response.status(403).json({ message: 'You may only change your own password.' })
    next()
}, changeOwnPassword)
module.exports = router
