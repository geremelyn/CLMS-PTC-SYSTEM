'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { triggerContractFailure } = require('../database/assetIdentifierTriggerContract.js')

const insertBody = `BEGIN
  IF NEW.asset_tag IS NOT NULL THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'computers', NEW.id); END IF;
  IF NEW.serial_number IS NOT NULL THEN INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'computers', NEW.id); END IF;
END`
const updateBody = `BEGIN DELETE FROM asset_identifier_registry WHERE source_type = 'equipment' AND source_id = OLD.id;
  INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('asset_tag', UPPER(TRIM(NEW.asset_tag)), 'equipment', NEW.id);
  INSERT INTO asset_identifier_registry (identifier_type, normalized_value, source_type, source_id) VALUES ('serial_number', UPPER(TRIM(NEW.serial_number)), 'equipment', NEW.id); END`
const deleteBody = `DELETE FROM asset_identifier_registry WHERE source_type = 'computers' AND source_id = OLD.id`

test('trigger contract accepts normalized insert behavior for both identifiers', () => {
  assert.equal(triggerContractFailure({ name: 'trg_computers_asset_identifiers_ai', event: 'INSERT', actionStatement: insertBody }), null)
})

test('trigger contract rejects a trigger that merely mentions the registry but does not register both identifiers', () => {
  const failure = triggerContractFailure({ name: 'trg_computers_asset_identifiers_ai', event: 'INSERT', actionStatement: "SELECT 'asset_identifier_registry'" })
  assert.match(failure, /required insert behavior/)
})

test('trigger contract requires updates to release old claims and register normalized new values', () => {
  assert.equal(triggerContractFailure({ name: 'trg_equipment_asset_identifiers_au', event: 'UPDATE', actionStatement: updateBody }), null)
  assert.match(triggerContractFailure({ name: 'trg_equipment_asset_identifiers_au', event: 'UPDATE', actionStatement: insertBody }), /cleanup|required update behavior/)
})

test('trigger contract requires deletes to release the correct source claims', () => {
  assert.equal(triggerContractFailure({ name: 'trg_computers_asset_identifiers_ad', event: 'DELETE', actionStatement: deleteBody }), null)
  assert.match(triggerContractFailure({ name: 'trg_equipment_asset_identifiers_ad', event: 'DELETE', actionStatement: deleteBody }), /cleanup|required update behavior/)
})
