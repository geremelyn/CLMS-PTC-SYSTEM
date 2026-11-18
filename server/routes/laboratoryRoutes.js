const express = require('express')
const { createLaboratory, getLaboratories, updateLaboratory } = require('../controllers/laboratoryController.js')
const { requireRole } = require('../middleware/roleAuth.js')
const router = express.Router()
const { withUpdateUndo } = require('../utils/updateUndo.js')
const simpleImport = require('../controllers/simpleImportController.js').createSimpleImportController('laboratories')
router.get('/', requireRole('MIS','Dean','Teacher','Inventory Staff','Others'), getLaboratories)
router.get('/import-template', requireRole('MIS'), require('../controllers/importTemplateController.js').createImportTemplateController('laboratories'))
router.post('/import-preview', requireRole('MIS'), (req, res, next) => { if (!req.body?.fileBase64) return res.status(400).json({ message: 'Choose a valid .xlsx file (maximum 5 MB).' }); return simpleImport.preview(req, res, next) })
router.post('/import', requireRole('MIS'), simpleImport.commit)
const { deleteLaboratories } = require('../controllers/recycleBinController.js')
router.post('/export', requireRole('MIS'), require('../controllers/dataExportController.js').createDataExportController('laboratories'))
// Delete Selected: same safe delete as the single delete (Recycle Bin, refused while computers/equipment/reservations use the lab).
router.post('/bulk-delete', requireRole('MIS'), deleteLaboratories)
router.post('/', requireRole('MIS'), createLaboratory)
router.put('/:id', requireRole('MIS'), withUpdateUndo('laboratories'), updateLaboratory)
// Deleting moves the laboratory to the Recycle Bin; refused (with counts) while computers, equipment or reservations use it.
router.delete('/:id', requireRole('MIS'), (request, response) => { request.body = { ids: [Number(request.params.id)] }; return deleteLaboratories(request, response) })
module.exports = router
