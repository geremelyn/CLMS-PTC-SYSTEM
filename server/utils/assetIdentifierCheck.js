'use strict'

const TABLE_BY_TYPE = Object.freeze({ computers: 'computers', equipment: 'equipment' })

/**
 * Friendly preflight check against the other asset category. Normalize the
 * same way as asset_identifier_registry; database triggers remain the final
 * authority for concurrent writes.
 */
function checkOtherAssetIdentifiers(db, type, assetTag, serialNumber, callback) {
  const ownTable = TABLE_BY_TYPE[type]
  if (!ownTable) return callback(new Error('Unsupported asset category.'))
  const otherTable = ownTable === 'computers' ? 'equipment' : 'computers'
  db.query(
    `SELECT id FROM ${otherTable} WHERE (asset_tag IS NOT NULL AND TRIM(asset_tag) <> '' AND UPPER(TRIM(asset_tag)) = UPPER(TRIM(?))) OR (serial_number IS NOT NULL AND TRIM(serial_number) <> '' AND UPPER(TRIM(serial_number)) = UPPER(TRIM(?))) LIMIT 1`,
    [assetTag, serialNumber],
    (error, rows) => callback(error, !error && Array.isArray(rows) && rows.length > 0)
  )
}

module.exports = { checkOtherAssetIdentifiers }
