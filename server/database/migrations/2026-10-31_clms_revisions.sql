-- CLMS revision migration (2026-10-31).
-- NOTE: The server applies these changes automatically at startup (server/database/ensureSchema.js).
-- Run this file manually only if you prefer to migrate the database yourself BEFORE starting the server.
-- It is idempotent (safe to run more than once) and works on MySQL 5.7+/8 and MariaDB.
-- No existing ENUM values, roles or data are modified.
-- Usage:  mysql -u <user> -p <database_name> < server/database/migrations/2026-10-31_clms_revisions.sql

DELIMITER $$
DROP PROCEDURE IF EXISTS clms_add_column_if_missing$$
CREATE PROCEDURE clms_add_column_if_missing(IN t VARCHAR(64), IN c VARCHAR(64), IN def VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @ddl = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', def);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- "Others" custom labels (ENUM columns stay unchanged)
CALL clms_add_column_if_missing('laboratories', 'status_other', 'VARCHAR(100) NULL');
CALL clms_add_column_if_missing('maintenance',  'status_other', 'VARCHAR(100) NULL');
CALL clms_add_column_if_missing('users',        'role_other',   'VARCHAR(100) NULL');

-- User name parts (full_name remains the stored display name)
CALL clms_add_column_if_missing('users', 'surname',        'VARCHAR(100) NULL');
CALL clms_add_column_if_missing('users', 'first_name',     'VARCHAR(100) NULL');
CALL clms_add_column_if_missing('users', 'middle_initial', 'VARCHAR(5) NULL');

-- Who cancelled a reservation (Undo Cancellation is offered only to that person)
CALL clms_add_column_if_missing('reservations', 'cancelled_by', 'INT NULL');

DROP PROCEDURE IF EXISTS clms_add_column_if_missing;

-- MIS-only Recycle Bin
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
