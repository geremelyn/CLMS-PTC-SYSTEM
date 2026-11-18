const db = require('../database/db.js')
const { workbookXml } = require('../utils/xlsxWriter.js')
// Excel export for Users and Laboratories. Rows are read from the DATABASE (never trusted from the browser) so the file
// always matches the saved records. The optional `ids` limits the export to the rows currently listed on screen.
// The users query never selects the password column.
function nameParts(user) {
  if (user.surname || user.first_name) return [user.surname || '', user.first_name || '', user.middle_initial || '']
  const tokens = String(user.full_name || '').trim().split(/\s+/).filter(Boolean)
  return tokens.length < 2 ? [tokens[0] || '', '', ''] : [tokens[tokens.length - 1], tokens.slice(0, -1).join(' '), '']
}
const roleText = user => user.role_other ? user.role_other : user.role === 'Teacher' && user.program ? `${user.program}-Teacher` : user.role === 'Inventory Staff' ? 'MIS Staff' : user.role === 'MIS' ? 'Super Admin' : user.role
const CONFIG = {
  users: {
    sheet: 'Users', filename: 'CLMS_Users_Export.xlsx',
    sql: "SELECT id, username, full_name, surname, first_name, middle_initial, program, role, role_other, COALESCE(status, 'ACTIVE') AS status FROM users",
    headers: ['ID Number', 'Surname', 'First Name', 'MI', 'Program', 'Role', 'Status'],
    toRow: user => [user.username, ...nameParts(user), user.program || '', roleText(user), user.status]
  },
  laboratories: {
    sheet: 'Laboratories', filename: 'CLMS_Laboratories_Export.xlsx',
    sql: `SELECT id, laboratory_name, capacity, status, status_other, TIME_FORMAT(available_from, '%H:%i') AS available_from, TIME_FORMAT(available_until, '%H:%i') AS available_until,
      DATE_FORMAT(available_date_from, '%Y-%m-%d') AS available_date_from, DATE_FORMAT(available_date_until, '%Y-%m-%d') AS available_date_until,
      DATE_FORMAT(unavailable_from, '%Y-%m-%d') AS unavailable_from, DATE_FORMAT(unavailable_until, '%Y-%m-%d') AS unavailable_until,
      DATE_FORMAT(used_from, '%Y-%m-%d') AS used_from, DATE_FORMAT(used_until, '%Y-%m-%d') AS used_until, reason FROM laboratories`,
    headers: ['Laboratory Name', 'Capacity', 'Status', 'Available From', 'Available Until', 'Available Date From', 'Available Date Until', 'Unavailable From', 'Unavailable Until', 'Used From', 'Used Until', 'Reason'],
    toRow: lab => [lab.laboratory_name, lab.capacity, lab.status_other || lab.status, lab.available_from, lab.available_until, lab.available_date_from, lab.available_date_until, lab.unavailable_from, lab.unavailable_until, lab.used_from, lab.used_until, lab.reason]
  }
}
function createDataExportController(type) {
  const config = CONFIG[type]
  return function exportData(request, response) {
    const ids = request.body?.ids
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 0))) return response.status(400).json({ message: 'Invalid list of records to export.' })
    const filtered = Array.isArray(ids)
    if (filtered && !ids.length) return response.status(400).json({ message: 'There are no records to export.' })
    const sql = `${config.sql}${filtered ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY id`
    db.query(sql, filtered ? ids.map(Number) : [], (error, rows) => {
      if (error) { console.error(`${type} export query failed:`, error.code || error.message); return response.status(500).json({ message: 'Unable to export records.' }) }
      try {
        const buffer = workbookXml(config.sheet, config.headers, rows.map(row => config.toRow(row).map(value => value == null ? '' : String(value))))
        response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        response.setHeader('Content-Disposition', `attachment; filename="${config.filename}"`)
        response.setHeader('Content-Length', String(buffer.length))
        response.status(200).send(buffer)
      } catch (writeError) { console.error(`${type} workbook failed:`, writeError.message); response.status(500).json({ message: 'Unable to generate Excel export.' }) }
    })
  }
}
module.exports = { createDataExportController, CONFIG }
