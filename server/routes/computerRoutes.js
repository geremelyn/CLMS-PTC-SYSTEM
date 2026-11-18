// MIS Staff (DB role 'Inventory Staff') may view, add, edit, delete (single + bulk) and export computers.
// Excel import is available to MIS and MIS Staff (same as Equipment).
const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { getComputers, createComputer, createQuickComputer, updateComputer, deleteComputer } = require('../controllers/computerController.js')
const { createExcelImportController } = require('../controllers/excelImportController.js')
const excelImport = createExcelImportController('computers')
const exportExcel = require('../controllers/excelExportController.js').createExcelExportController('computers')
const bulkActions = require('../controllers/bulkRecordController.js').createBulkRecordController('computers')
router.get('/', requireRole('MIS','Inventory Staff','Teacher','Dean','Others'), getComputers) // CP85: Report Issue needs the same asset list Teachers get
router.post('/export', requireRole('MIS','Inventory Staff','Teacher','Dean'), exportExcel)
router.post('/bulk-delete', requireRole('MIS','Inventory Staff'), bulkActions.bulkDelete)
router.post('/undo-bulk-delete/:undoId', requireRole('MIS','Inventory Staff'), bulkActions.undoDelete)
router.get('/import-template', requireRole('MIS','Inventory Staff'), require('../controllers/importTemplateController.js').createImportTemplateController('computers'))
router.post('/import-preview', requireRole('MIS','Inventory Staff'), (req, res, next) => { if (!req.body?.fileBase64) return res.status(400).json({ message: 'Choose a valid .xlsx file (maximum 5 MB).' }); return excelImport.preview(req, res, next) })
router.post('/import', requireRole('MIS','Inventory Staff'), excelImport.commit)
router.post('/quick', requireRole('MIS','Inventory Staff'), createQuickComputer)
router.post('/', requireRole('MIS','Inventory Staff'), createComputer)
router.put('/:id', requireRole('MIS','Inventory Staff'), updateComputer)
router.delete('/:id', requireRole('MIS','Inventory Staff'), deleteComputer)
module.exports = router
