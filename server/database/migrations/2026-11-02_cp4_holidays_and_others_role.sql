-- CLMS Checkpoint 4 migration (2026-11-02). OPTIONAL: the server applies all of this automatically at startup
-- (server/database/ensureSchema.js). Run manually only if you prefer to migrate before starting the server.
-- Idempotent except where noted. Usage: mysql -u <user> -p <database_name> < this_file.sql

-- 1) 'Others' role value (additive superset of the old ENUM; existing values and rows are untouched).
ALTER TABLE users MODIFY COLUMN role ENUM('MIS','Dean','Teacher','Inventory Staff','Others') NOT NULL;
-- Legacy custom-role accounts were stored as Teacher with role_other set; real teachers never have role_other.
UPDATE users SET role = 'Others', program = NULL WHERE role = 'Teacher' AND role_other IS NOT NULL AND TRIM(role_other) <> '';

-- 2) Holidays (Asia/Manila calendar dates). Removal is a soft delete (is_active = 0).
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) Holiday-conflict flags on reservations (run each ALTER once; the server skips columns that already exist).
-- ALTER TABLE reservations ADD COLUMN holiday_flag TINYINT(1) NOT NULL DEFAULT 0;
-- ALTER TABLE reservations ADD COLUMN holiday_flag_note VARCHAR(255) NULL;
-- ALTER TABLE reservations ADD COLUMN holiday_flagged_at DATETIME NULL;

-- The verified 2026 holiday rows are inserted by the server (INSERT IGNORE) from server/utils/philippineHolidays.js.
