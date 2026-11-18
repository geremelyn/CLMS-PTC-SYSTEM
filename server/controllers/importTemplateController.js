'use strict'
// GET /<module>/import-template -> downloads the Excel template for that module's import. Read-only; no database access.
const { SPECS, buildTemplate } = require('../utils/importTemplates.js')
function createImportTemplateController(type) {
  return function downloadTemplate(request, response) {
    try {
      const buffer = buildTemplate(type)
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      response.setHeader('Content-Disposition', `attachment; filename="${SPECS[type].fileName}"`)
      response.setHeader('Content-Length', buffer.length)
      return response.status(200).send(buffer)
    } catch (error) {
      console.error(`${type} import template failed:`, error.message)
      return response.status(500).json({ message: 'Unable to create the template right now. Please try again.' })
    }
  }
}
module.exports = { createImportTemplateController }
