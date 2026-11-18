const { workbookXml } = require('../utils/xlsxWriter.js')
const CONFIG = {
  computers: {
    sheet: 'Computers', filename: 'CLMS_Computers_Export.xlsx',
    columns: [
      ['Computer Name', 'computer_name'], ['Laboratory ID', 'laboratory_id'], ['Asset Tag', 'asset_tag'],
      ['Serial Number', 'serial_number'], ['Processor', 'processor'], ['RAM', 'ram'],
      ['Storage Capacity', 'storage_capacity'], ['Storage Unit', 'storage_unit'], ['Storage Type', 'storage_type'],
      ['Operational Status', 'operational_status'], ['Condition', 'condition'], ['Condition Note', 'condition_note'], ['Notes', 'notes']
    ]
  },
  equipment: {
    sheet: 'Equipment', filename: 'CLMS_Equipment_Export.xlsx',
    columns: [
      ['Equipment Type', 'equipment_type'], ['Laboratory ID', 'laboratory_id'], ['Computer Assignment (ID or exact computer name)', 'computer_id'],
      ['Asset Tag', 'asset_tag'], ['Serial Number', 'serial_number'], ['Status', 'equipment_state'], ['Condition', 'status'], ['Condition Note', 'condition_note'],
      ['Added By ID Number', 'reported_by_username'], ['Added Date', 'report_date'], ['Notes', 'notes']
    ]
  }
}
function createExcelExportController(type) {
  return function exportExcel(request, response) {
    const input = request.body?.rows
    if (!Array.isArray(input) || input.length > 10000) return response.status(400).json({ message: 'Provide the filtered rows to export (maximum 10,000 rows).' })
    const config = CONFIG[type]
    const rows = input.map(item => config.columns.map(([, field]) => {
      const value = item?.[field]
      if (value instanceof Date) return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
      return value == null ? '' : String(value)
    }))
    try {
      const buffer = workbookXml(config.sheet, config.columns.map(([header]) => header), rows)
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      response.setHeader('Content-Disposition', `attachment; filename="${config.filename}"`)
      response.setHeader('Content-Length', String(buffer.length))
      return response.status(200).send(buffer)
    } catch (error) {
      console.error(`${type} Excel export failed:`, error)
      return response.status(500).json({ message: 'Unable to generate Excel export.' })
    }
  }
}
module.exports = { createExcelExportController, CONFIG }
