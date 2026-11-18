const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/roleAuth.js')
const { getOptions, createOption, deleteOption } = require('../controllers/lookupOptionController.js')
router.get('/', requireRole('MIS','Inventory Staff'), getOptions)
router.post('/', requireRole('MIS','Inventory Staff'), createOption)
router.delete('/:id', requireRole('MIS','Inventory Staff'), deleteOption)
module.exports = router
