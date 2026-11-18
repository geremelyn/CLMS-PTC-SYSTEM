-- CLMS non-destructive schema additions for an existing ptc_clms database.
-- BACK UP THE DATABASE FIRST. This script adds missing columns/tables only.
-- It does not DROP, TRUNCATE, DELETE, or re-import application records.
-- The backend's ensureSchema.js applies the required checks automatically at startup.
-- Run manually only if directed by your database administrator and using MariaDB 10.4+.

USE ptc_clms;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS program ENUM('BSIT','BSOA') NULL;

ALTER TABLE laboratories
  ADD COLUMN IF NOT EXISTS available_from TIME NULL,
  ADD COLUMN IF NOT EXISTS available_until TIME NULL,
  ADD COLUMN IF NOT EXISTS booking_interval INT NULL;

ALTER TABLE computers
  ADD COLUMN IF NOT EXISTS laboratory_id INT NULL,
  ADD COLUMN IF NOT EXISTS operational_status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS `condition` ENUM('WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED') NOT NULL DEFAULT 'WORKING',
  ADD COLUMN IF NOT EXISTS condition_note VARCHAR(255) NULL;

ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS laboratory_id INT NULL,
  ADD COLUMN IF NOT EXISTS computer_id INT NULL,
  ADD COLUMN IF NOT EXISTS condition_note VARCHAR(255) NULL;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cancellation_note VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE maintenance
  ADD COLUMN IF NOT EXISTS status ENUM('PENDING','IN PROGRESS','COMPLETED','CLOSED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS maintenance_note VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS date_reported DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS date_resolved DATETIME NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NULL,
  action VARCHAR(100) NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS session_revocations (
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_hash),
  KEY idx_session_revocations_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
