const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
function loadImportController({ failInsertNumber = 0, type = 'computers' } = {}) {
  const calls = []
  let insertCount = 0
  const connection = {
    beginTransaction(callback) { calls.push('BEGIN'); callback(null) },
    commit(callback) { calls.push('COMMIT'); callback(null) },
    rollback(callback) { calls.push('ROLLBACK'); callback(null) },
    release() { calls.push('RELEASE') },
    query(sql, values, callback) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push(normalized)
      if (normalized.startsWith('SELECT id FROM laboratories WHERE id = ? FOR UPDATE')) return callback(null, [{ id: values[0] }])   // CP181 lock
      if (normalized.startsWith('SELECT id, laboratory_name, capacity FROM laboratories')) return callback(null, [{ id: 1, laboratory_name: 'Lab A', capacity: 50 }])
      if (normalized.startsWith('SELECT id, computer_name, laboratory_id FROM computers')) return callback(null, [{ id: 10, computer_name: 'PC-LAB1-01', laboratory_id: 1 }])
      if (normalized.startsWith('SELECT asset_tag, serial_number FROM computers')) return callback(null, [])
      if (normalized.startsWith('SELECT asset_tag, serial_number FROM equipment')) return callback(null, [])
      if (normalized.startsWith('SELECT category, value FROM lookup_options')) return callback(null, [
        { category: 'computer_storage_unit', value: 'GB' }, { category: 'computer_storage_type', value: 'SSD' },
        { category: 'computer_status', value: 'ACTIVE' }, { category: 'computer_condition', value: 'WORKING' },
        { category: 'equipment_type', value: 'Projector' }, { category: 'equipment_status', value: 'WORKING' }
      ])
      if (normalized.startsWith('INSERT INTO computers') || normalized.startsWith('INSERT INTO equipment')) {
        insertCount++
        if (insertCount === failInsertNumber) return callback(Object.assign(new Error('simulated insert failure'), { code: 'ER_BAD_FIELD_ERROR' }))
        return callback(null, { affectedRows: 1, insertId: insertCount })
      }
      throw new Error(`Unexpected mock SQL: ${normalized}`)
    }
  }
  const fakeDb = {
    getConnection(callback) { callback(null, connection) },
    query(sql, values, callback) { if (typeof values === 'function') callback = values; if (callback) callback(null, { affectedRows: 1, insertId: 1 }) }
  }
  const dbPath = path.resolve(__dirname, '../database/db.js')
  const auditPath = path.resolve(__dirname, '../utils/auditLogger.js')
  const controllerPath = path.resolve(__dirname, '../controllers/excelImportController.js')
  const fakeModule = new Module(dbPath); fakeModule.filename = dbPath; fakeModule.loaded = true; fakeModule.exports = fakeDb; require.cache[dbPath] = fakeModule
  delete require.cache[auditPath]; delete require.cache[controllerPath]
  const controller = require('../controllers/excelImportController.js').createExcelImportController(type)
  return { handler: controller.commit, preview: controller.preview, calls }
}
function responseMock() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }
const valid = (name, tag, serial) => ({ rowNumber: 2, data: { computer_name: name, laboratory_id: 1, asset_tag: tag, serial_number: serial, processor: 'Intel i5', ram: 8, storage_capacity: 256, storage_unit: 'GB', storage_type: 'SSD', operational_status: 'ACTIVE', condition: 'WORKING', condition_note: '' } })

test('Excel import controller commits all valid rows in one transaction', async () => {
  const { handler, calls } = loadImportController()
  const response = responseMock()
  await handler({ body: { rows: [valid('PC-1', 'TAG-1', 'SN-1'), valid('PC-2', 'TAG-2', 'SN-2')] }, user: { id: 5, role: 'MIS' } }, response)
  assert.equal(response.code, 201)
  assert.equal(response.body.importedCount, 2)
  assert.ok(calls.includes('BEGIN'))
  assert.ok(calls.includes('COMMIT'))
  assert.ok(!calls.includes('ROLLBACK'))
  assert.equal(calls.filter(call => call.startsWith('INSERT INTO computers')).length, 2)
})
test('Excel import controller rejects invalid rows and rolls back before inserting any record', async () => {
  const { handler, calls } = loadImportController()
  const response = responseMock()
  await handler({ body: { rows: [valid('', 'TAG-1', 'SN-1')] }, user: { id: 5, role: 'MIS' } }, response)
  assert.equal(response.code, 409)
  assert.match(response.body.message, /No rows were saved/i)
  assert.ok(Array.isArray(response.body.rows))
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(call => call.startsWith('INSERT INTO computers')))
})
test('Excel import controller rolls back all rows when a later insert fails', async () => {
  const { handler, calls } = loadImportController({ failInsertNumber: 2 })
  const response = responseMock()
  await handler({ body: { rows: [valid('PC-1', 'TAG-1', 'SN-1'), valid('PC-2', 'TAG-2', 'SN-2')] }, user: { id: 5, role: 'MIS' } }, response)
  assert.equal(response.code, 500)
  assert.match(response.body.message, /rolled back/i)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.includes('COMMIT'))
})

test('Equipment import controller commits valid rows and validates computer assignment inside the transaction', async () => {
  const { handler, calls } = loadImportController({ type: 'equipment' })
  const response = responseMock()
  const row = { rowNumber: 2, data: { equipment_type: 'Projector', laboratory_id: 1, computer_id: 10, asset_tag: 'EQ-1', serial_number: 'EQ-SN-1', brand: 'Demo', model: 'P1', status: 'WORKING', condition_note: '' } }
  await handler({ body: { rows: [row] }, user: { id: 5, role: 'Inventory Staff' } }, response)
  assert.equal(response.code, 201)
  assert.equal(response.body.importedCount, 1)
  assert.ok(calls.some(call => call.startsWith('INSERT INTO equipment')))
  assert.ok(calls.includes('COMMIT'))
})
test('Preview controller parses the actual sample workbook and returns row-level preview results', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { preview } = loadImportController({ type: 'computers' })
  const workbookPath = path.join(__dirname, '../../templates/CLMS_Sample_Excel_Template.xlsx')
  const response = responseMock()
  await preview({ body: { fileName: 'CLMS_Sample_Excel_Template.xlsx', fileBase64: fs.readFileSync(workbookPath).toString('base64') } }, response)
  assert.equal(response.code, 200)
  assert.equal(response.body.allValid, true)
  assert.equal(response.body.validCount, 1)
  assert.equal(response.body.rows[0].rowNumber, 2)
  assert.equal(response.body.rows[0].data.computer_name, 'PC-LAB1-01')
})
test('Equipment preview parses the sample workbook and resolves computer assignment against references', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { preview } = loadImportController({ type: 'equipment' })
  const workbookPath = path.join(__dirname, '../../templates/CLMS_Sample_Excel_Template.xlsx')
  const response = responseMock()
  await preview({ body: { fileName: 'CLMS_Sample_Excel_Template.xlsx', fileBase64: fs.readFileSync(workbookPath).toString('base64') } }, response)
  assert.equal(response.code, 200)
  assert.equal(response.body.allValid, true)
  assert.equal(response.body.validCount, 1)
  assert.equal(response.body.rows[0].data.computer_id, 10)
})
