const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { validateRows } = require('../utils/excelImportValidation.js')
const { runInTransaction } = require('../utils/transactionalImport.js')
const { parseWorkbookRows, MAX_ROWS } = require('../utils/excelWorkbookRows.js')
const { userFacingMessage } = require('../utils/importDiagnostics.js')
function query(connection, sql, values = []) { return new Promise((resolve, reject) => connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows))) }
function getConnection() { return new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection))) }
// CP181: a computers import counts against laboratory capacity, so it takes the same laboratory row locks (FOR UPDATE, ascending id) as
// Add Computer, transfers and Recycle Bin restore BEFORE any non-locking read. Competing creates/transfers/imports/restores for those laboratories
// then queue, and the snapshot used for the capacity count (first consistent read of the transaction) already includes everything they committed.
async function lockImportLaboratories(connection, rows) {
  const ids = [...new Set(rows.map(row => Number((row && row.data ? row.data : row || {}).laboratory_id)).filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b)
  for (const id of ids) await query(connection, 'SELECT id FROM laboratories WHERE id = ? FOR UPDATE', [id])
}
async function referenceData(connection, type) {
  // Read both asset tables in a stable order. During an import transaction the FOR UPDATE
  // reads serialize competing imports and detect identifiers duplicated across asset categories.
  const laboratories = await query(connection, 'SELECT id, laboratory_name, capacity FROM laboratories')
  const computers = await query(connection, 'SELECT id, computer_name, laboratory_id FROM computers')
  const computerIdentifiers = await query(connection, 'SELECT asset_tag, serial_number FROM computers FOR UPDATE')
  const equipmentIdentifiers = await query(connection, 'SELECT asset_tag, serial_number FROM equipment FOR UPDATE')
  const optionRows = await query(connection, 'SELECT category, value FROM lookup_options')
  const options = {}
  for (const row of optionRows) (options[row.category] ||= []).push(row.value)
  const existing = [...computerIdentifiers, ...equipmentIdentifiers]
  return { laboratories, computers, existingTags: existing.map(row => row.asset_tag), existingSerials: existing.map(row => row.serial_number), options }
}

const fail = (res, status, message) => res.status(status).json({ message })
function createExcelImportController(type) {
  async function preview(request, response) {
    let connection
    try {
      const encoded = String(request.body?.fileBase64 || '')
      if (!/\.xlsx$/i.test(String(request.body?.fileName || '')) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 7 * 1024 * 1024) throw new Error('Choose a valid .xlsx workbook no larger than 5 MB.')
      const rows = parseWorkbookRows(Buffer.from(encoded, 'base64'), type, request.body?.fileName)
      connection = await getConnection()
      const validated = validateRows(rows, type, await referenceData(connection, type))
      return response.json({ rows: validated, validCount: validated.filter(row => row.valid).length, errorCount: validated.filter(row => !row.valid).length, allValid: validated.every(row => row.valid) })
    } catch (error) {
      console.error(`${type} import preview failed:`, error.message)
      return fail(response, String(error.message).includes('xlsx dependency') ? 503 : 400, userFacingMessage(error, 'The workbook could not be checked. Make sure it is a valid .xlsx file and try again. Nothing was saved.'))
    } finally { connection?.release() }
  }
  async function commit(request, response) {
    const rows = Array.isArray(request.body?.rows) ? request.body.rows : null
    if (!rows?.length || rows.length > MAX_ROWS) return fail(response, 400, `Provide between 1 and ${MAX_ROWS} rows to import.`)
    let connection
    try {
      connection = await getConnection()
      const importedCount = await runInTransaction(connection, async () => {
        if (type === 'computers') await lockImportLaboratories(connection, rows)
        const validated = validateRows(rows.map((row, index) => ({ rowNumber: row.rowNumber || index + 2, data: row.data || row })), type, await referenceData(connection, type))
        const invalid = validated.filter(row => !row.valid)
        if (invalid.length) {
          const error = new Error('Import validation failed')
          error.importValidation = invalid.map(row => ({ rowNumber: row.rowNumber, errors: row.errors }))
          throw error
        }
        for (const { data: d } of validated) {
          if (type === 'computers') {
            await query(connection, 'INSERT INTO computers (computer_name, laboratory_id, asset_tag, serial_number, processor, ram, storage_capacity, storage_unit, storage_type, operational_status, `condition`, condition_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [d.computer_name, d.laboratory_id, d.asset_tag, d.serial_number, d.processor, d.ram, d.storage_capacity, d.storage_unit, d.storage_type, d.operational_status, d.condition, d.condition_note || null])
          } else {
            await query(connection, 'INSERT INTO equipment (equipment_type, laboratory_id, computer_id, asset_tag, serial_number, brand, model, status, equipment_state, condition_note, reported_by, report_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())', [d.equipment_type, d.laboratory_id, d.computer_id, d.asset_tag, d.serial_number, d.brand || null, d.model || null, d.status, d.equipment_state || 'ACTIVE', d.condition_note || null, request.user?.id ?? null])
          }
        }
        return validated.length
      })
      logAudit(request.user?.id, 'BULK ASSET IMPORT', `Imported ${importedCount} ${type} records from Excel.`)
      return response.status(201).json({ message: `${importedCount} ${type} records imported successfully.`, importedCount })
    } catch (error) {
      console.error(`${type} import failed; transaction rolled back:`, error.code || error.message)
      if (error.importValidation) return response.status(409).json({ message: 'Import cancelled because one or more rows are invalid or now conflict with saved records. No rows were saved.', rows: error.importValidation })
      if (error.code === 'ER_DUP_ENTRY') return fail(response, 409, 'Import stopped because an asset tag or serial number now duplicates a saved record. No rows were saved.')
      return fail(response, 500, 'Import failed and was rolled back. No rows were saved.')
    } finally { connection?.release() }
  }

  return { preview, commit }
}
module.exports = { createExcelImportController, parseWorkbookRows }
