'use strict'
// SQLITE test harness (node:sqlite, in-memory). NOT MySQL/MariaDB.
// It lets the real controller SQL run against a real SQL engine (real transactions, real rollback, real row counts),
// translating only the few MySQL-only constructs the delete controllers use. Anything it cannot translate throws,
// so a test never silently passes on an unsupported statement.
const path = require('node:path')
const Module = require('node:module')
const { DatabaseSync } = require('node:sqlite')

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, full_name TEXT, role TEXT, status TEXT DEFAULT 'ACTIVE', password TEXT);
CREATE TABLE laboratories (id INTEGER PRIMARY KEY, laboratory_name TEXT, capacity INTEGER, status TEXT, available_from TEXT, available_until TEXT);
CREATE TABLE computers (id INTEGER PRIMARY KEY, computer_name TEXT, laboratory_id INTEGER, asset_tag TEXT, serial_number TEXT, processor TEXT, ram INTEGER, storage_capacity INTEGER, storage_unit TEXT, storage_type TEXT, operational_status TEXT, "condition" TEXT, condition_note TEXT);
CREATE TABLE equipment (id INTEGER PRIMARY KEY, equipment_type TEXT, laboratory_id INTEGER, computer_id INTEGER, asset_tag TEXT, serial_number TEXT, brand TEXT, model TEXT, status TEXT, condition_note TEXT, reported_by INTEGER, report_date TEXT);
CREATE TABLE maintenance (id INTEGER PRIMARY KEY, computer_id INTEGER, equipment_id INTEGER, reported_by INTEGER, status TEXT DEFAULT 'PENDING', date_reported TEXT DEFAULT CURRENT_TIMESTAMP, issue_description TEXT, maintenance_note TEXT, date_resolved TEXT, status_other TEXT);
CREATE TABLE reservations (id INTEGER PRIMARY KEY, laboratory_id INTEGER, reserved_by INTEGER, decided_by INTEGER, cancelled_by INTEGER, reservation_date TEXT, start_time TEXT, end_time TEXT, status TEXT, subject_name TEXT, purpose TEXT);
CREATE TABLE holidays (id INTEGER PRIMARY KEY, holiday_date TEXT, name TEXT, holiday_type TEXT, custom_type_label TEXT, source TEXT, is_verified INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1, updated_by INTEGER);
CREATE TABLE recycle_bin (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, label TEXT, snapshot_json TEXT NOT NULL, deleted_by INTEGER, deleted_at TEXT DEFAULT CURRENT_TIMESTAMP, restored_at TEXT, restored_by INTEGER);
CREATE TABLE undo_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, used_at TEXT);
`

function translate(sql, values) {
  let text = sql.replace(/\s+FOR UPDATE\b/gi, '')
  text = text.replace(/^\s*INSERT IGNORE\b/i, 'INSERT OR IGNORE') // CP118: MySQL INSERT IGNORE -> SQLite INSERT OR IGNORE
  text = text.replace(/TIMESTAMPDIFF\(SECOND, created_at, NOW\(\)\)/gi, 'CAST((julianday(CURRENT_TIMESTAMP) - julianday(created_at)) * 86400 AS INTEGER)')
  text = text.replace(/DATE_ADD\(NOW\(\), INTERVAL (\d+) DAY\)/gi, "datetime('now','+$1 days')").replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
  let params = values
  if (/VALUES \?\s*$/i.test(text.trim())) { // MySQL bulk insert: VALUES ? with [[row, row, ...]]
    const rows = values[0]
    text = text.trim().replace(/VALUES \?\s*$/i, 'VALUES ' + rows.map(row => `(${row.map(() => '?').join(',')})`).join(','))
    params = rows.flat()
  }
  if (/\bIN \(\)/i.test(text)) throw new Error('empty IN () list: ' + text)
  return { text, params: params.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value) }
}

function createSqliteDb({ failWhen } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA)
  sqlite.function('DATE_FORMAT', value => (value == null ? null : String(value).slice(0, 10))) // only the '%Y-%m-%d' use in holidayService
  const state = { failWhen: failWhen || null, log: [] }
  const connection = {
    beginTransaction(cb) { sqlite.exec('BEGIN'); cb(null) },
    commit(cb) { try { sqlite.exec('COMMIT'); cb(null) } catch (e) { cb(e) } },
    rollback(cb) { try { sqlite.exec('ROLLBACK') } catch { /* nothing open */ } cb(null) },
    release() {},
    query(sql, values, cb) {
      if (typeof values === 'function') { cb = values; values = [] }
      try {
        const normalized = sql.replace(/\s+/g, ' ').trim(); state.log.push(normalized)
        if (state.failWhen) { const error = state.failWhen(normalized); if (error) throw error }
        const { text, params } = translate(sql, values || [])
        const statement = sqlite.prepare(text)
        if (/^\s*(SELECT|PRAGMA)/i.test(text)) return cb(null, statement.all(...params).map(row => ({ ...row })))
        const result = statement.run(...params)
        cb(null, { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) })
      } catch (error) { cb(error) }
    }
  }
  const db = { getConnection: cb => cb(null, connection), query: (sql, values, cb) => connection.query(sql, values, cb), sqlite, state }
  return db
}

function stub(rel, exports) { const p = path.resolve(__dirname, rel); const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports; require.cache[p] = m }
function loadControllers(db) {
  stub('../../database/db.js', db)
  stub('../../utils/auditLogger.js', { logAudit() {} })
  for (const f of ['bulkRecordController', 'recycleBinController']) delete require.cache[path.resolve(__dirname, `../../controllers/${f}.js`)]
  return { bulk: require('../../controllers/bulkRecordController.js'), bin: require('../../controllers/recycleBinController.js') }
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const count = (db, table, where = '1=1') => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n
module.exports = { createSqliteDb, loadControllers, res, count }
