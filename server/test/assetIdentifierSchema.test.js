'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const schema = fs.readFileSync(path.join(__dirname, '../database/ensureSchema.js'), 'utf8')

test('schema migration creates a shared unique registry for tags and serials', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS asset_identifier_registry/)
  assert.match(schema, /PRIMARY KEY \(identifier_type, normalized_value\)/)
  assert.match(schema, /UPPER\(TRIM\(asset_tag\)\)/)
  assert.match(schema, /UPPER\(TRIM\(serial_number\)\)/)
})

test('schema migration installs insert, update, and delete triggers for both asset tables', () => {
  for (const table of ['computers', 'equipment']) {
    for (const suffix of ['ai', 'au', 'ad']) {
      assert.match(schema, new RegExp(`trg_${table}_asset_identifiers_${suffix}`))
    }
  }
  assert.match(schema, /Cannot enable shared asset identifier enforcement/)
  assert.match(schema, /HAVING COUNT\(\*\) > 1 LIMIT 1/)
})


test('registry migration reconciles stale claims before seeding and uses explicit trigger columns', () => {
  assert.match(schema, /DELETE r FROM asset_identifier_registry r[\s\S]*LEFT JOIN computers c/)
  assert.match(schema, /DELETE r FROM asset_identifier_registry r[\s\S]*LEFT JOIN equipment e/)
  assert.match(schema, /UPPER\(TRIM\(c\.asset_tag\)\) <> r\.normalized_value/)
  assert.match(schema, /INSERT INTO asset_identifier_registry \(identifier_type, normalized_value, source_type, source_id\) VALUES/)
})


test('shared identifier enforcement fails closed unless source tables and registry are InnoDB', () => {
  assert.match(schema, /async function assertInnoDB\(table\)/)
  assert.match(schema, /await assertInnoDB\('computers'\)/)
  assert.match(schema, /await assertInnoDB\('equipment'\)/)
  assert.match(schema, /await assertInnoDB\('asset_identifier_registry'\)/)
  assert.match(schema, /Asset identifier enforcement requires InnoDB/)
})

test('schema startup verifies installed trigger event, timing, and registry maintenance body', () => {
  assert.match(schema, /const requiredTriggers = \[/)
  assert.match(schema, /EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT FROM information_schema\.TRIGGERS/)
  assert.match(schema, /does not maintain asset_identifier_registry|is missing or invalid/)
})
