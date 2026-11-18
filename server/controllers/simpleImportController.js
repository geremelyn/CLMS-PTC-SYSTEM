const bcrypt = require('bcrypt')
const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { parseXlsx } = require('../utils/xlsxParser.js')
const { mapRow, validateSimpleRows } = require('../utils/simpleImportRows.js')
const { runInTransaction } = require('../utils/transactionalImport.js')
const { missingColumnsMessage, userFacingMessage } = require('../utils/importDiagnostics.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')
const MAX_ROWS = 2000
const query = (connection, sql, values = []) => new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
const getConnection = () => new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection)))
const TABLE = { laboratories: ['laboratories', 'laboratory_name'], users: ['users', 'username'] }

// Import for Laboratories and Users: preview (validate only) then commit (one transaction, all-or-nothing).
function createSimpleImportController(type) {
  const [table, keyColumn] = TABLE[type]
  async function existingKeys(connection) { return (await query(connection, `SELECT \`${keyColumn}\` AS k FROM ${table}`)).map(row => row.k) }
  async function preview(request, response) {
    let connection
    try {
      const encoded = String(request.body?.fileBase64 || '')
      if (!/\.xlsx$/i.test(String(request.body?.fileName || '')) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 7 * 1024 * 1024) throw new Error('Choose a valid .xlsx workbook no larger than 5 MB.')
      const sheets = parseXlsx(Buffer.from(encoded, 'base64'))
      const matrix = sheets[Object.keys(sheets)[0]]
      if (!matrix) throw new Error('The workbook does not contain a readable worksheet.')
      const headerIndex = matrix.findIndex(row => row.some(value => String(value ?? '').trim() !== ''))
      const sheetName = Object.keys(sheets)[0]
      if (headerIndex >= 0) { const columnProblem = missingColumnsMessage(sheetName, matrix[headerIndex], type); if (columnProblem) throw new Error(columnProblem) }
      const rows = headerIndex < 0 ? [] : matrix.slice(headerIndex + 1).map((values, index) => ({ rowNumber: headerIndex + index + 2, data: mapRow(matrix[headerIndex], values || [], type) })).filter(row => Object.values(row.data).some(value => String(value ?? '').trim() !== ''))
      if (!rows.length) throw new Error('The worksheet must contain a header row and at least one data row.')
      if (rows.length > MAX_ROWS) throw new Error(`The import is limited to ${MAX_ROWS} rows per file.`)
      connection = await getConnection()
      const validated = validateSimpleRows(rows, type, { existing: await existingKeys(connection) })
      return response.json({ rows: validated, validCount: validated.filter(row => row.valid).length, errorCount: validated.filter(row => !row.valid).length, allValid: validated.every(row => row.valid) })
    } catch (error) {
      console.error(`${type} import preview failed:`, error.message)
      return response.status(400).json({ message: userFacingMessage(error, 'The workbook could not be checked. Make sure it is a valid .xlsx file and try again. Nothing was saved.') })
    } finally { connection?.release() }
  }
  async function commit(request, response) {
    const rows = Array.isArray(request.body?.rows) ? request.body.rows : null
    if (!rows?.length || rows.length > MAX_ROWS) return response.status(400).json({ message: `Provide between 1 and ${MAX_ROWS} rows to import.` })
    let connection
    try {
      connection = await getConnection()
      const count = await runInTransaction(connection, async () => {
        // Re-validate on the server; the client preview is never trusted.
        const incoming = rows.map((row, index) => ({ rowNumber: row.rowNumber || index + 2, data: row.rawData || row.data || row }))
        const validated = validateSimpleRows(incoming.map(row => ({ rowNumber: row.rowNumber, data: type === 'users' ? rebuildUserInput(row.data) : rebuildLabInput(row.data) })), type, { existing: await existingKeys(connection) })
        const invalid = validated.filter(row => !row.valid)
        if (invalid.length) throw Object.assign(new Error('Import validation failed'), { importValidation: invalid.map(row => ({ rowNumber: row.rowNumber, errors: row.errors })) })
        for (const { data: d } of validated) {
          if (type === 'laboratories') {
            await query(connection, 'INSERT INTO laboratories (laboratory_name, capacity, status, available_from, available_until, booking_interval, reason, status_other) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [d.laboratory_name, d.capacity, d.status, d.available_from || RESERVATION_POLICY.fallbackLabOpeningTime, d.available_until || RESERVATION_POLICY.fallbackLabClosingTime, d.booking_interval, d.status === 'UNAVAILABLE' ? d.reason : null, d.status_other])
          } else {
            const hashed = await bcrypt.hash(d.password, 10)
            // Imported accounts must change their initial password at first sign-in. Custom-role (Others) accounts are inactive label-only records.
            await query(connection, 'INSERT INTO users (full_name, username, password, role, status, program, must_change_password, role_other, surname, first_name, middle_initial) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)', [d.full_name, d.username, hashed, d.role, 'ACTIVE', d.program, d.role_other, d.surname, d.first_name, d.middle_initial])
          }
        }
        return validated.length
      })
      logAudit(request.user?.id, `${type.toUpperCase()} IMPORT`, `Imported ${count} ${type} from Excel.`)
      return response.status(201).json({ message: `${count} ${type} imported successfully.`, importedCount: count })
    } catch (error) {
      console.error(`${type} import failed; rolled back:`, error.code || error.message)
      if (error.importValidation) return response.status(409).json({ message: 'Import cancelled because one or more rows are invalid or now conflict with saved records. No rows were saved.', rows: error.importValidation })
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'Import stopped because a record now duplicates a saved one. No rows were saved.' })
      return response.status(500).json({ message: 'Import failed and was rolled back. No rows were saved.' })
    } finally { connection?.release() }
  }
  return { preview, commit }
}
// The preview returns validated (normalized) data; convert back to the raw column shape so commit validates it again.
function rebuildLabInput(d) { return { ...d, status: d.status_other ? 'OTHERS' : d.status } }
function rebuildUserInput(d) { return { username: d.username, surname: d.surname, first_name: d.first_name, middle_initial: d.middle_initial, password: d.password, program: d.program, role: d.role_other ? d.role_other : d.role }
}
module.exports = { createSimpleImportController }
