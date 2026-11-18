const db = require('./db.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')
const { triggerContractFailure } = require('./assetIdentifierTriggerContract.js')

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => error ? reject(error) : resolve(results))
  })
}

async function tableExists(table) {
  const rows = await run('SHOW TABLES LIKE ?', [table])
  return rows.length > 0
}

async function columnExists(table, column) {
  if (!(await tableExists(table))) return false
  const rows = await run(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column])
  return rows.length > 0
}

async function addColumn(table, column, definition) {
  if (!(await columnExists(table, column))) {
    await run(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function ensureAutoIncrement(table) {
  if (!(await tableExists(table))) return

  const columns = await run(`SHOW COLUMNS FROM \`${table}\` LIKE 'id'`)
  if (!columns.length) return

  const idColumn = columns[0]
  const isAutoIncrement = String(idColumn.Extra || '').toLowerCase().includes('auto_increment')

  // Do not rebuild an already-correct primary-key column. On imported MariaDB
  // tables, ALTER TABLE ... MODIFY can unnecessarily rebuild the table and fail
  // because of existing foreign-key references (notably users -> audit_logs).
  if (!isAutoIncrement) {
    await run(`ALTER TABLE \`${table}\` MODIFY COLUMN \`id\` INT NOT NULL AUTO_INCREMENT`)
  }

  const rows = await run(`SELECT COALESCE(MAX(\`id\`), 0) + 1 AS next_id FROM \`${table}\``)
  const nextId = Math.max(1, Number(rows[0]?.next_id || 1))
  const statusRows = await run('SELECT AUTO_INCREMENT AS current_next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])
  const currentNextId = Number(statusRows[0]?.current_next_id || 0)
  // Never lower the counter: an existing database may intentionally have a
  // higher next ID because records were removed or migrated previously.
  if (!currentNextId || currentNextId < nextId) {
    await run(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${nextId}`)
  }
}

// CP84: databases imported from dumps that lost AUTO_INCREMENT can hold a reservation with id = 0 (the primary key allows only one).
// The page then sees an id that is not a positive integer, so Delete / Delete All reports "no valid id" for that row and every
// id-based action on it (decide, cancel, delete) is refused. Give that single row the next free id. Nothing else is changed and
// nothing is deleted; it is a no-op when no such row exists. (Only applied to reservations; users keep their separate legacy handling.)
async function repairZeroIdRows(table) {
  if (!(await tableExists(table))) return 0
  const zero = await run(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE id = 0`)
  if (!Number(zero[0]?.n)) return 0
  const next = await run(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM \`${table}\``)
  await run(`UPDATE \`${table}\` SET id = ? WHERE id = 0 LIMIT 1`, [Number(next[0].next_id)])
  console.warn(`Repaired a ${table} row that had id 0 (new id ${next[0].next_id}).`)
  return 1
}

async function ensureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT,
      full_name VARCHAR(100) NOT NULL,
      username VARCHAR(50) NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('MIS','Dean','Teacher','Inventory Staff','Others') NOT NULL,
      status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      must_change_password TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  await addColumn('users', 'status', "ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'")
  // Existing Dean/Teacher accounts are required to change their password on the next login.
  await addColumn('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 1')
  await addColumn('users', 'program', "ENUM('BSIT','BSOA') NULL")
  // CP69: Teacher Program "Others" stores the admin's custom program name, so the column becomes plain text. Widening ENUM -> VARCHAR keeps
  // every existing value (BSIT / BSOA / NULL) unchanged.
  try { await run("ALTER TABLE users MODIFY COLUMN program VARCHAR(100) NULL") } catch (error) { console.warn('Users program type was not widened:', error.message) }
  // 'Others' is appended (superset of the old ENUM, so existing rows/values are untouched). Custom-role accounts use it
  // instead of 'Teacher' so they never inherit Teacher permissions.
  let othersRoleAvailable = false
  try { await run("ALTER TABLE users MODIFY COLUMN role ENUM('MIS','Dean','Teacher','Inventory Staff','Others') NOT NULL"); othersRoleAvailable = true } catch (error) { console.warn('Users role enum was not modified:', error.message) }

  try { await run("ALTER TABLE users MODIFY COLUMN status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'") } catch (error) { console.warn('Users status enum was not modified:', error.message) }

  await run(`
    CREATE TABLE IF NOT EXISTS laboratories (
      id INT NOT NULL AUTO_INCREMENT,
      laboratory_name VARCHAR(100) NOT NULL,
      capacity INT NOT NULL DEFAULT 1,
      status ENUM('OPEN','USED','UNAVAILABLE') NOT NULL DEFAULT 'OPEN',
      available_from TIME NOT NULL DEFAULT '${RESERVATION_POLICY.fallbackLabOpeningTime}',
      available_until TIME NOT NULL DEFAULT '${RESERVATION_POLICY.fallbackLabClosingTime}',
      booking_interval INT NOT NULL DEFAULT ${RESERVATION_POLICY.defaultBookingInterval},
      available_date_from DATE NULL,
      available_date_until DATE NULL,
      unavailable_from DATE NULL,
      unavailable_until DATE NULL,
      used_from DATE NULL,
      used_until DATE NULL,
      reason VARCHAR(255) NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  await addColumn('laboratories', 'available_from', "TIME NULL")
  await addColumn('laboratories', 'available_until', "TIME NULL")
  await addColumn('laboratories', 'booking_interval', "INT NULL")
  await addColumn('laboratories', 'available_date_from', 'DATE NULL')
  await addColumn('laboratories', 'available_date_until', 'DATE NULL')
  await addColumn('laboratories', 'unavailable_from', 'DATE NULL')
  await addColumn('laboratories', 'unavailable_until', 'DATE NULL')
  await addColumn('laboratories', 'used_from', 'DATE NULL')
  await addColumn('laboratories', 'used_until', 'DATE NULL')
  await addColumn('laboratories', 'reason', 'VARCHAR(255) NULL')
  // The college identified the typing room as the fourth laboratory. Preserve
  // existing lab records and add it only when exactly three labs exist and no
  // typing-room record is already present.
  await run(`INSERT INTO laboratories (laboratory_name, capacity, status, available_from, available_until, booking_interval)
    SELECT 'Typing Room', 1, 'OPEN', '${RESERVATION_POLICY.fallbackLabOpeningTime}', '${RESERVATION_POLICY.fallbackLabClosingTime}', ${RESERVATION_POLICY.defaultBookingInterval}
    WHERE (SELECT COUNT(*) FROM laboratories) = 3
      AND NOT EXISTS (SELECT 1 FROM laboratories WHERE LOWER(laboratory_name) LIKE '%typing%')`)

  await run(`
    CREATE TABLE IF NOT EXISTS computers (
      id INT NOT NULL AUTO_INCREMENT,
      computer_name VARCHAR(100) NULL,
      laboratory_id INT NULL,
      asset_tag VARCHAR(100) NULL,
      serial_number VARCHAR(100) NULL,
      processor VARCHAR(100) NULL,
      ram INT NULL,
      storage_capacity INT NULL,
      storage_unit ENUM('GB','TB') NULL,
      storage_type ENUM('HDD','SSD') NULL,
      operational_status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      \`condition\` ENUM('WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED') NOT NULL DEFAULT 'WORKING',
      condition_note VARCHAR(255) NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  await addColumn('computers', 'laboratory_id', 'INT NULL')
  await addColumn('computers', 'operational_status', "ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'")
  await addColumn('computers', 'condition', "ENUM('WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED') NOT NULL DEFAULT 'WORKING'")
  await addColumn('computers', 'condition_note', 'VARCHAR(255) NULL')
  try { await run("ALTER TABLE computers MODIFY COLUMN operational_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'") } catch (error) { console.warn('Computer operational status type was not modified:', error.message) }
  try { await run("ALTER TABLE computers MODIFY COLUMN `condition` VARCHAR(50) NOT NULL DEFAULT 'WORKING'") } catch (error) { console.warn('Computer condition type was not modified:', error.message) }
  try { await run("ALTER TABLE computers MODIFY COLUMN storage_unit VARCHAR(20) NULL") } catch (error) { console.warn('Computer storage unit type was not modified:', error.message) }
  try { await run("ALTER TABLE computers MODIFY COLUMN storage_type VARCHAR(50) NULL") } catch (error) { console.warn('Computer storage type was not modified:', error.message) }

  await run(`
    CREATE TABLE IF NOT EXISTS equipment (
      id INT NOT NULL AUTO_INCREMENT,
      equipment_type VARCHAR(100) NOT NULL,
      laboratory_id INT NOT NULL,
      computer_id INT NULL,
      asset_tag VARCHAR(100) NOT NULL,
      serial_number VARCHAR(100) NOT NULL,
      brand VARCHAR(100) NULL,
      model VARCHAR(100) NULL,
      status ENUM('WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED') NOT NULL DEFAULT 'WORKING',
      condition_note VARCHAR(255) NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  await addColumn('equipment', 'laboratory_id', 'INT NULL')
  await addColumn('equipment', 'computer_id', 'INT NULL')
  await addColumn('equipment', 'condition_note', 'VARCHAR(255) NULL')
  // CP164: Equipment now has two fields. `status` keeps its CP117 meaning and is shown as Condition (Working / Not Working / Others; it drives
  // Maintenance). The new `equipment_state` is the administrative Status (Active / Inactive / Others). Legacy rows whose `status` held
  // ACTIVE / INACTIVE are moved once into equipment_state (idempotent: afterwards no row has those values in `status`) and read as Working.
  await addColumn('equipment', 'equipment_state', "VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'")
  await run("UPDATE equipment SET equipment_state = 'INACTIVE', status = 'WORKING' WHERE UPPER(TRIM(status)) = 'INACTIVE'")
  await run("UPDATE equipment SET status = 'WORKING' WHERE UPPER(TRIM(status)) = 'ACTIVE'")
  await addColumn('equipment', 'reported_by', 'INT NULL')
  await addColumn('equipment', 'report_date', 'DATETIME NULL')
  try { await run("ALTER TABLE equipment MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'WORKING'") } catch (error) { console.warn('Equipment status type was not modified:', error.message) }

  // Enforce identifier uniqueness in the database so concurrent imports and form submissions
  // cannot race past application-level duplicate checks. Existing duplicate legacy data is reported
  // and deliberately not destructively rewritten by startup migration.
  async function ensureUniqueIdentifier(table, column, indexName) {
    const indexes = await run(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName])
    if (indexes.length) return
    const duplicates = await run(`SELECT \`${column}\` AS identifier, COUNT(*) AS occurrences FROM \`${table}\` WHERE \`${column}\` IS NOT NULL GROUP BY \`${column}\` HAVING COUNT(*) > 1 LIMIT 1`)
    if (duplicates.length) {
      console.warn(`Unique index ${indexName} was not created because duplicate legacy ${table}.${column} values exist. Clean those records to enable database-enforced uniqueness.`)
      return
    }
    await run(`CREATE UNIQUE INDEX \`${indexName}\` ON \`${table}\` (\`${column}\`)`)
  }
  await ensureUniqueIdentifier('laboratories', 'laboratory_name', 'uq_laboratories_name')
  await ensureUniqueIdentifier('computers', 'asset_tag', 'uq_computers_asset_tag')
  await ensureUniqueIdentifier('computers', 'serial_number', 'uq_computers_serial_number')
  await ensureUniqueIdentifier('equipment', 'asset_tag', 'uq_equipment_asset_tag')
  await ensureUniqueIdentifier('equipment', 'serial_number', 'uq_equipment_serial_number')

  // A unique index on each table cannot prevent a computer and an equipment
  // row from claiming the same identifier concurrently. A shared registry plus
  // table triggers makes the database the final authority for both categories
  // and for every write path (forms, imports, bulk operations, undo, and SQL).
  await run(`CREATE TABLE IF NOT EXISTS asset_identifier_registry (
    identifier_type ENUM('asset_tag','serial_number') NOT NULL,
    normalized_value VARCHAR(100) NOT NULL,
    source_type ENUM('computers','equipment') NOT NULL,
    source_id INT NOT NULL,
    PRIMARY KEY (identifier_type, normalized_value),
    UNIQUE KEY uq_asset_identifier_source (source_type, source_id, identifier_type),
    KEY idx_asset_identifier_source (source_type, source_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`)

  // Trigger-backed uniqueness is only atomic when both source tables and the
  // registry use a transactional engine. Legacy installations may have tables
  // created outside this initializer, so fail closed rather than claiming global
  // uniqueness on MyISAM (where a trigger failure cannot roll back the base write).
  async function assertInnoDB(table) {
    const rows = await run('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])
    const engine = String(rows[0]?.ENGINE || '').toUpperCase()
    if (engine !== 'INNODB') {
      throw new Error(`Asset identifier enforcement requires InnoDB for table \"${table}\" (found ${engine || 'unknown'}). Back up the database and convert this table safely before starting CLMS.`)
    }
  }
  await assertInnoDB('computers')
  await assertInnoDB('equipment')
  await assertInnoDB('asset_identifier_registry')

  // Refuse to silently choose a winner if legacy data already violates the
  // cross-category rule. This is a safe startup blocker requiring data cleanup.
  const crossDuplicates = await run(`
    SELECT identifier_type, normalized_value, COUNT(*) AS occurrences FROM (
      SELECT 'asset_tag' AS identifier_type, UPPER(TRIM(asset_tag)) AS normalized_value FROM computers WHERE asset_tag IS NOT NULL AND TRIM(asset_tag) <> ''
      UNION ALL SELECT 'serial_number', UPPER(TRIM(serial_number)) FROM computers WHERE serial_number IS NOT NULL AND TRIM(serial_number) <> ''
      UNION ALL SELECT 'asset_tag', UPPER(TRIM(asset_tag)) FROM equipment WHERE asset_tag IS NOT NULL AND TRIM(asset_tag) <> ''
      UNION ALL SELECT 'serial_number', UPPER(TRIM(serial_number)) FROM equipment WHERE serial_number IS NOT NULL AND TRIM(serial_number) <> ''
    ) identifiers GROUP BY identifier_type, normalized_value HAVING COUNT(*) > 1 LIMIT 1`)
  if (crossDuplicates.length) {
    throw new Error(`Cannot enable shared asset identifier enforcement: duplicate ${crossDuplicates[0].identifier_type} value "${crossDuplicates[0].normalized_value}" exists across Computers/Assets & Equipment or within legacy records. Resolve the duplicate safely, then restart.`)
  }

  // Reconcile stale registry entries before seeding. This handles an interrupted
  // earlier startup where triggers were not yet installed, or legacy records that
  // were changed while enforcement was unavailable. Only registry claims that no
  // longer match their source row are removed; source records are never modified.
  await run(`DELETE r FROM asset_identifier_registry r
    LEFT JOIN computers c ON c.id = r.source_id
    WHERE r.source_type = 'computers' AND (
      c.id IS NULL OR
      (r.identifier_type = 'asset_tag' AND (c.asset_tag IS NULL OR TRIM(c.asset_tag) = '' OR UPPER(TRIM(c.asset_tag)) <> r.normalized_value)) OR
      (r.identifier_type = 'serial_number' AND (c.serial_number IS NULL OR TRIM(c.serial_number) = '' OR UPPER(TRIM(c.serial_number)) <> r.normalized_value))
    )`)
  await run(`DELETE r FROM asset_identifier_registry r
    LEFT JOIN equipment e ON e.id = r.source_id
    WHERE r.source_type = 'equipment' AND (
      e.id IS NULL OR
      (r.identifier_type = 'asset_tag' AND (e.asset_tag IS NULL OR TRIM(e.asset_tag) = '' OR UPPER(TRIM(e.asset_tag)) <> r.normalized_value)) OR
      (r.identifier_type = 'serial_number' AND (e.serial_number IS NULL OR TRIM(e.serial_number) = '' OR UPPER(TRIM(e.serial_number)) <> r.normalized_value))
    )`)

  // Seed the registry from current records. The duplicate check above prevents
  // ambiguous ownership; reconciliation makes reruns recover from stale claims.
  await run(`INSERT IGNORE INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id)
    SELECT 'asset_tag', UPPER(TRIM(asset_tag)), 'computers', id FROM computers WHERE asset_tag IS NOT NULL AND TRIM(asset_tag) <> ''
    UNION ALL SELECT 'serial_number', UPPER(TRIM(serial_number)), 'computers', id FROM computers WHERE serial_number IS NOT NULL AND TRIM(serial_number) <> ''
    UNION ALL SELECT 'asset_tag', UPPER(TRIM(asset_tag)), 'equipment', id FROM equipment WHERE asset_tag IS NOT NULL AND TRIM(asset_tag) <> ''
    UNION ALL SELECT 'serial_number', UPPER(TRIM(serial_number)), 'equipment', id FROM equipment WHERE serial_number IS NOT NULL AND TRIM(serial_number) <> ''`)

  async function ensureTrigger(name, sql) {
    const found = await run('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [name])
    if (!found.length) await run(sql)
  }
  await ensureTrigger('trg_computers_asset_identifiers_ai', `CREATE TRIGGER trg_computers_asset_identifiers_ai AFTER INSERT ON computers FOR EACH ROW BEGIN
    IF NEW.asset_tag IS NOT NULL AND TRIM(NEW.asset_tag) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'computers', NEW.id); END IF;
    IF NEW.serial_number IS NOT NULL AND TRIM(NEW.serial_number) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'computers', NEW.id); END IF;
  END`)
  await ensureTrigger('trg_computers_asset_identifiers_au', `CREATE TRIGGER trg_computers_asset_identifiers_au AFTER UPDATE ON computers FOR EACH ROW BEGIN
    DELETE FROM asset_identifier_registry WHERE source_type = 'computers' AND source_id = OLD.id;
    IF NEW.asset_tag IS NOT NULL AND TRIM(NEW.asset_tag) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'computers', NEW.id); END IF;
    IF NEW.serial_number IS NOT NULL AND TRIM(NEW.serial_number) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'computers', NEW.id); END IF;
  END`)
  await ensureTrigger('trg_computers_asset_identifiers_ad', `CREATE TRIGGER trg_computers_asset_identifiers_ad AFTER DELETE ON computers FOR EACH ROW DELETE FROM asset_identifier_registry WHERE source_type = 'computers' AND source_id = OLD.id`)
  await ensureTrigger('trg_equipment_asset_identifiers_ai', `CREATE TRIGGER trg_equipment_asset_identifiers_ai AFTER INSERT ON equipment FOR EACH ROW BEGIN
    IF NEW.asset_tag IS NOT NULL AND TRIM(NEW.asset_tag) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'equipment', NEW.id); END IF;
    IF NEW.serial_number IS NOT NULL AND TRIM(NEW.serial_number) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'equipment', NEW.id); END IF;
  END`)
  await ensureTrigger('trg_equipment_asset_identifiers_au', `CREATE TRIGGER trg_equipment_asset_identifiers_au AFTER UPDATE ON equipment FOR EACH ROW BEGIN
    DELETE FROM asset_identifier_registry WHERE source_type = 'equipment' AND source_id = OLD.id;
    IF NEW.asset_tag IS NOT NULL AND TRIM(NEW.asset_tag) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'equipment', NEW.id); END IF;
    IF NEW.serial_number IS NOT NULL AND TRIM(NEW.serial_number) <> '' THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'equipment', NEW.id); END IF;
  END`)
  await ensureTrigger('trg_equipment_asset_identifiers_ad', `CREATE TRIGGER trg_equipment_asset_identifiers_ad AFTER DELETE ON equipment FOR EACH ROW DELETE FROM asset_identifier_registry WHERE source_type = 'equipment' AND source_id = OLD.id`)

  // Existing trigger names alone are not proof that enforcement is active: an
  // interrupted/hand-edited installation could leave a same-named trigger with
  // an obsolete body. Verify all six installed definitions before allowing startup.
  const requiredTriggers = [
    ['trg_computers_asset_identifiers_ai', 'INSERT', 'AFTER'],
    ['trg_computers_asset_identifiers_au', 'UPDATE', 'AFTER'],
    ['trg_computers_asset_identifiers_ad', 'DELETE', 'AFTER'],
    ['trg_equipment_asset_identifiers_ai', 'INSERT', 'AFTER'],
    ['trg_equipment_asset_identifiers_au', 'UPDATE', 'AFTER'],
    ['trg_equipment_asset_identifiers_ad', 'DELETE', 'AFTER']
  ]
  for (const [name, event, timing] of requiredTriggers) {
    const rows = await run('SELECT EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [name])
    const trigger = rows[0]
    const eventMatches = trigger && String(trigger.EVENT_MANIPULATION).toUpperCase() === event
    const timingMatches = trigger && String(trigger.ACTION_TIMING).toUpperCase() === timing
    const contractFailure = trigger && eventMatches && timingMatches
      ? triggerContractFailure({ name, event, actionStatement: trigger.ACTION_STATEMENT })
      : 'trigger event or timing does not match the required definition'
    if (!trigger || !eventMatches || !timingMatches || contractFailure) {
      throw new Error(`Asset identifier trigger ${name} is missing or invalid (${contractFailure || 'unknown error'}). Back up the database, repair the trigger, then restart CLMS.`)
    }
  }

  await run(`
    CREATE TABLE IF NOT EXISTS reservations (
      id INT NOT NULL AUTO_INCREMENT,
      laboratory_id INT NOT NULL,
      reserved_by INT NOT NULL,
      reservation_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      purpose VARCHAR(255) NOT NULL,
      status ENUM('PENDING','APPROVED','DECLINED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      cancellation_note VARCHAR(255) NULL,
      decision_note VARCHAR(255) NULL,
      decided_by INT NULL,
      decided_at DATETIME NULL,
      subject_name VARCHAR(150) NULL,
      professor_name VARCHAR(150) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  await addColumn('reservations', 'cancellation_note', 'VARCHAR(255) NULL')
  await addColumn('reservations', 'decision_note', 'VARCHAR(255) NULL')
  await addColumn('reservations', 'decided_by', 'INT NULL')
  await addColumn('reservations', 'decided_at', 'DATETIME NULL')
  await addColumn('reservations', 'subject_name', 'VARCHAR(150) NULL')
  await addColumn('reservations', 'professor_name', 'VARCHAR(150) NULL')
  await addColumn('reservations', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await addColumn('reservations', 'cancelled_at', 'DATETIME NULL')
  // Holiday conflicts: reservations that already existed when a date was declared a non-working holiday are FLAGGED, never deleted.
  await addColumn('reservations', 'holiday_flag', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn('reservations', 'holiday_flag_note', 'VARCHAR(255) NULL')
  await addColumn('reservations', 'holiday_flagged_at', 'DATETIME NULL')
  // Who cancelled: lets the UI/API offer "Undo cancellation" only to the person who cancelled.
  await addColumn('reservations', 'cancelled_by', 'INT NULL')
  // CP42: the slot-conflict check runs `SELECT ... FOR UPDATE` on (laboratory_id, reservation_date, status). Without an index
  // InnoDB scans (and locks) every reservation row, so unrelated bookings/decisions block each other. Additive and idempotent;
  // portable MySQL/MariaDB existence check via information_schema (the IF-NOT-EXISTS index form is MariaDB-only).
  try {
    const existing = await run("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'reservations' AND index_name = 'idx_reservations_lab_date_status' LIMIT 1")
    if (!existing.length) await run('ALTER TABLE reservations ADD INDEX idx_reservations_lab_date_status (laboratory_id, reservation_date, status)')
  } catch (error) { console.warn('Reservation conflict index was not created:', error.message) }
  try { await run("ALTER TABLE reservations MODIFY COLUMN status ENUM('PENDING','APPROVED','DECLINED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING'") } catch (error) { console.warn('Reservation status enum was not modified:', error.message) }

  await run(`
    CREATE TABLE IF NOT EXISTS maintenance (
      id INT NOT NULL AUTO_INCREMENT,
      computer_id INT NULL,
      equipment_id INT NULL,
      reported_by INT NOT NULL,
      issue_description VARCHAR(255) NOT NULL,
      status ENUM('PENDING','IN PROGRESS','COMPLETED','CLOSED') NOT NULL DEFAULT 'PENDING',
      maintenance_note VARCHAR(255) NULL,
      date_reported DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      date_resolved DATETIME NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  await addColumn('maintenance', 'status', "ENUM('PENDING','IN PROGRESS','COMPLETED','CLOSED') NOT NULL DEFAULT 'PENDING'")
  await addColumn('maintenance', 'maintenance_note', 'VARCHAR(255) NULL')
  await addColumn('maintenance', 'date_reported', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await addColumn('maintenance', 'date_resolved', 'DATETIME NULL')
  try { await run("ALTER TABLE maintenance MODIFY COLUMN status ENUM('PENDING','IN PROGRESS','COMPLETED','CLOSED') NOT NULL DEFAULT 'PENDING'") } catch (error) { console.warn('Maintenance status enum was not modified:', error.message) }

  await run(`
    CREATE TABLE IF NOT EXISTS session_revocations (
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token_hash),
      KEY idx_session_revocations_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS lookup_options (
      id INT NOT NULL AUTO_INCREMENT,
      category VARCHAR(60) NOT NULL,
      value VARCHAR(100) NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_lookup_category_value (category, value),
      KEY idx_lookup_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS undo_actions (
      id INT NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(40) NOT NULL,
      snapshot_json LONGTEXT NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_undo_expiry (expires_at),
      KEY idx_undo_creator (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  // Persistent MIS-only Recycle Bin. Snapshots are written in the same transaction as the delete.
  await run(`
    CREATE TABLE IF NOT EXISTS recycle_bin (
      id INT NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(40) NOT NULL,
      entity_id INT NOT NULL,
      label VARCHAR(255) NULL,
      snapshot_json LONGTEXT NOT NULL,
      deleted_by INT NULL,
      deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      restored_at DATETIME NULL,
      restored_by INT NULL,
      PRIMARY KEY (id),
      KEY idx_recycle_active (restored_at, deleted_at),
      KEY idx_recycle_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  // "Others" custom labels live in separate nullable columns; ENUM definitions are untouched.
  await addColumn('laboratories', 'status_other', 'VARCHAR(100) NULL')
  await addColumn('maintenance', 'status_other', 'VARCHAR(100) NULL')
  await addColumn('users', 'role_other', 'VARCHAR(100) NULL')
  if (othersRoleAvailable) {
    // Legacy custom-role accounts were stored as Teacher with role_other set (real teachers never have role_other).
    try { await run("UPDATE users SET role='Others', program=NULL WHERE role='Teacher' AND role_other IS NOT NULL AND TRIM(role_other) <> ''") } catch (error) { console.warn('Legacy Others accounts were not migrated:', error.message) }
  }
  // CP118: registry of custom role names (so a custom role can exist without users and be deleted safely). Additive; existing accounts are untouched.
  await run(`CREATE TABLE IF NOT EXISTS custom_roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_custom_roles_name (role_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`)
  try { await run("INSERT IGNORE INTO custom_roles (role_name) SELECT MIN(TRIM(role_other)) FROM users WHERE role = 'Others' AND role_other IS NOT NULL AND TRIM(role_other) <> '' GROUP BY LOWER(TRIM(role_other))") } catch (error) { console.warn('Existing custom roles were not registered:', error.message) }
  await addColumn('users', 'surname', 'VARCHAR(100) NULL')
  await addColumn('users', 'first_name', 'VARCHAR(100) NULL')
  await addColumn('users', 'middle_initial', 'VARCHAR(5) NULL')

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      description TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audit_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  // CP121: teacher schedule uploads (proof + record keeping). Every upload is its own row - nothing is replaced or deleted.
  // No foreign keys on purpose: user deletion/safe-delete behaviour is unchanged and old uploads are kept.
  await run(`
    CREATE TABLE IF NOT EXISTS teacher_schedules (
      id INT NOT NULL AUTO_INCREMENT,
      teacher_id INT NOT NULL,
      uploaded_by INT NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(100) NULL,
      file_size INT NOT NULL,
      file_data LONGBLOB NOT NULL,
      uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_teacher_schedules_teacher (teacher_id, uploaded_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)

  // CP128: teacher schedule delete = soft delete (row and file kept; hidden from active lists/View/Download; restorable from the Recycle Bin).
  await addColumn('teacher_schedules', 'deleted_at', 'DATETIME NULL')
  await addColumn('teacher_schedules', 'deleted_by', 'INT NULL')

  // Philippine holidays (Asia/Manila). One row per date; removal is a soft delete (is_active = 0) so a removed
  // baseline date is never re-seeded. Reservation validation reads this table (built-in baseline is the fallback).
  await run(`
    CREATE TABLE IF NOT EXISTS holidays (
      id INT NOT NULL AUTO_INCREMENT,
      holiday_date DATE NOT NULL,
      name VARCHAR(150) NOT NULL,
      holiday_type ENUM('REGULAR','SPECIAL_NON_WORKING','SPECIAL_WORKING') NOT NULL,
      source VARCHAR(255) NULL,
      is_verified TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_holiday_date (holiday_date),
      KEY idx_holiday_active (is_active, holiday_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `)
  // Revision 10: custom (Others) holiday type. Adding an ENUM value + a nullable column never touches existing rows.
  try { await run("ALTER TABLE holidays MODIFY COLUMN holiday_type ENUM('REGULAR','SPECIAL_NON_WORKING','SPECIAL_WORKING','OTHER') NOT NULL") } catch (error) { console.warn('Holiday type enum was not modified:', error.message) }
  await addColumn('holidays', 'custom_type_label', 'VARCHAR(100) NULL')
  try {
    // Seed every verified year (2026 = Proc. 1006/1189/1264/1447; 2027 = Proc. 1427). INSERT IGNORE never overwrites
    // MIS edits and never resurrects a removed (soft-deleted) date.
    const { baselineForYear, verifiedYears } = require('../utils/philippineHolidays.js')
    for (const year of verifiedYears()) {
      for (const entry of baselineForYear(year)) {
        await run('INSERT IGNORE INTO holidays (holiday_date, name, holiday_type, source, is_verified, is_active) VALUES (?, ?, ?, ?, ?, 1)', [entry.holiday_date, entry.name, entry.holiday_type, entry.source, entry.is_verified ? 1 : 0])
      }
    }
    // Reservations that already exist on a closed date (e.g. dates added by an upgrade) are FLAGGED for review, never deleted.
    await run(`UPDATE reservations r JOIN holidays h ON h.holiday_date = r.reservation_date AND h.is_active = 1 AND h.holiday_type IN ('REGULAR','SPECIAL_NON_WORKING','OTHER')
      SET r.holiday_flag = 1, r.holiday_flag_note = LEFT(CONCAT(h.name, ' - date is now closed. Review, reschedule or cancel.'), 255), r.holiday_flagged_at = NOW()
      WHERE r.status IN ('PENDING','APPROVED') AND r.holiday_flag = 0`)
  } catch (error) { console.warn('Holiday seed skipped:', error.message) }

  await run(`DELETE FROM session_revocations WHERE expires_at <= UTC_TIMESTAMP()`)
  await run(`UPDATE users SET status='ACTIVE' WHERE status IS NULL OR status=''`)
  await run(`UPDATE laboratories SET available_from='${RESERVATION_POLICY.fallbackLabOpeningTime}' WHERE available_from IS NULL`)
  await run(`UPDATE laboratories SET available_until='${RESERVATION_POLICY.fallbackLabClosingTime}' WHERE available_until IS NULL`)
  await run(`UPDATE laboratories SET booking_interval=${RESERVATION_POLICY.defaultBookingInterval} WHERE booking_interval IS NULL OR booking_interval <= 0`)
  await run(`UPDATE maintenance SET status='CLOSED' WHERE (status IS NULL OR status='') AND date_resolved IS NOT NULL`)
  await run(`UPDATE maintenance SET status='PENDING' WHERE (status IS NULL OR status='') AND date_resolved IS NULL`)

  // Repair databases imported from phpMyAdmin dumps where existing primary-key
  // columns were not restored as AUTO_INCREMENT. This is important for users
  // (including the legacy Dean id=0) and reservations: inserts must receive a
  // new id from MariaDB instead of repeatedly trying to insert id=0.
  try { await repairZeroIdRows('reservations') } catch (error) { console.warn('Reservation id repair skipped:', error.message) }
  for (const table of ['users','laboratories','computers','equipment','reservations','maintenance','audit_logs']) {
    try {
      await ensureAutoIncrement(table)
    } catch (error) {
      console.warn(`AUTO_INCREMENT repair skipped for ${table}:`, error.message)
    }
  }

  console.log('Database schema/data checks completed.')
}

module.exports = { ensureSchema, repairZeroIdRows }
