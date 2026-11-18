-- OPTIONAL, MANUAL SEED ONLY — DO NOT RUN AUTOMATICALLY.
-- Proposed volume: 80 records per category, 20 per laboratory across four canonical
-- labs, for at most 480 new equipment records total (6 categories x 80).
-- This script does not delete or update existing equipment. It inserts only rows
-- whose generated asset tag AND serial number are not already present.
--
-- IMPORTANT: Review the exact proposed volume and this SQL before running it.
-- It requires exactly one lab named Laboratory 1, Laboratory 2, Laboratory 3,
-- and Laboratory 4 (case-insensitive, surrounding spaces ignored). It intentionally
-- aborts if those names are missing or duplicated; it does not assume lab IDs.
-- Assigned computer is set only for mouse, headset, keyboard, and webcam, and only
-- when a PC01-PC20 computer exists in the same lab. Printer/scanner are shared.
-- This seed is separate from normal startup and is never called by ensureSchema.js.

DELIMITER $$
DROP PROCEDURE IF EXISTS clms_optional_seed_equipment_80_each$$
CREATE PROCEDURE clms_optional_seed_equipment_80_each()
BEGIN
  DECLARE v_lab_count INT DEFAULT 0;
  DECLARE v_inserted INT DEFAULT 0;

  DROP TEMPORARY TABLE IF EXISTS clms_seed_labs;
  DROP TEMPORARY TABLE IF EXISTS clms_seed_numbers;
  DROP TEMPORARY TABLE IF EXISTS clms_seed_types;

  CREATE TEMPORARY TABLE clms_seed_labs (
    lab_number INT NOT NULL PRIMARY KEY,
    laboratory_id INT NOT NULL UNIQUE
  );

  INSERT INTO clms_seed_labs (lab_number, laboratory_id)
  SELECT CAST(SUBSTRING(TRIM(laboratory_name), LENGTH('Laboratory ') + 1) AS UNSIGNED), id
  FROM laboratories
  WHERE LOWER(TRIM(laboratory_name)) IN ('laboratory 1','laboratory 2','laboratory 3','laboratory 4');

  SELECT COUNT(*) INTO v_lab_count FROM clms_seed_labs;
  IF v_lab_count <> 4 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Seed aborted: expected exactly one each of Laboratory 1-4; inspect actual laboratory names first.';
  END IF;

  CREATE TEMPORARY TABLE clms_seed_numbers (item_number INT NOT NULL PRIMARY KEY);
  INSERT INTO clms_seed_numbers (item_number) VALUES
    (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),
    (11),(12),(13),(14),(15),(16),(17),(18),(19),(20);

  CREATE TEMPORARY TABLE clms_seed_types (
    equipment_type VARCHAR(20) NOT NULL PRIMARY KEY,
    type_code CHAR(3) NOT NULL UNIQUE,
    brand VARCHAR(100) NOT NULL,
    model VARCHAR(100) NOT NULL,
    computer_assigned TINYINT NOT NULL
  );
  INSERT INTO clms_seed_types VALUES
    ('MOUSE','MOU','Logitech','M185',1),
    ('HEADSET','HEA','Logitech','H390',1),
    ('KEYBOARD','KEY','Logitech','K120',1),
    ('PRINTER','PRI','Epson','EcoTank L3250',0),
    ('SCANNER','SCA','Epson','DS-1630',0),
    ('WEBCAM','WEB','Logitech','C920',1);

  INSERT INTO equipment
    (equipment_type, laboratory_id, computer_id, asset_tag, serial_number, brand, model, status, condition_note)
  SELECT
    t.equipment_type,
    l.laboratory_id,
    CASE WHEN t.computer_assigned = 1 THEN pc.id ELSE NULL END,
    CONCAT('EQ-L', l.lab_number, '-', t.type_code, '-', LPAD(n.item_number, 3, '0')),
    CONCAT('SN-L', l.lab_number, '-', t.type_code, '-', LPAD(n.item_number, 3, '0')),
    t.brand,
    t.model,
    'WORKING',
    NULL
  FROM clms_seed_labs l
  CROSS JOIN clms_seed_numbers n
  CROSS JOIN clms_seed_types t
  LEFT JOIN computers pc
    ON t.computer_assigned = 1
   AND pc.laboratory_id = l.laboratory_id
   AND LOWER(REPLACE(REPLACE(TRIM(pc.computer_name), ' ', ''), '-', '')) = CONCAT('pc', LPAD(n.item_number, 2, '0'))
  WHERE NOT EXISTS (
    SELECT 1 FROM equipment e
    WHERE e.asset_tag = CONCAT('EQ-L', l.lab_number, '-', t.type_code, '-', LPAD(n.item_number, 3, '0'))
       OR e.serial_number = CONCAT('SN-L', l.lab_number, '-', t.type_code, '-', LPAD(n.item_number, 3, '0'))
  );

  SET v_inserted = ROW_COUNT();
  SELECT 480 AS proposed_maximum_records, v_inserted AS records_inserted, 80 AS target_records_per_category;

  DROP TEMPORARY TABLE IF EXISTS clms_seed_labs;
  DROP TEMPORARY TABLE IF EXISTS clms_seed_numbers;
  DROP TEMPORARY TABLE IF EXISTS clms_seed_types;
END$$
DELIMITER ;

-- Intentional action: uncomment the CALL only after reviewing the proposed 480-row maximum
-- and confirming the four laboratory names and existing inventory with your administrator.
-- CALL clms_optional_seed_equipment_80_each();
-- DROP PROCEDURE IF EXISTS clms_optional_seed_equipment_80_each;
