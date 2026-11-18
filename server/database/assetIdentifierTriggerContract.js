'use strict'

/**
 * Validate the minimum SQL contract required for the shared identifier registry.
 * information_schema.ACTION_STATEMENT is normalized before checking because
 * MySQL/MariaDB may vary whitespace and keyword casing in its representation.
 * This is a fail-closed structural guard, not a substitute for live DB tests.
 */
function triggerContractFailure({ name, event, actionStatement }) {
  const sourceType = String(name || '').includes('computers_') ? 'COMPUTERS' :
    String(name || '').includes('equipment_') ? 'EQUIPMENT' : null
  if (!sourceType) return 'unknown source table'

  const body = String(actionStatement || '').toUpperCase().replace(/[\s`]/g, '')
  const has = fragment => body.includes(fragment)
  if (!has('ASSET_IDENTIFIER_REGISTRY')) return 'registry table is not referenced'

  if (event === 'INSERT' || event === 'UPDATE') {
    for (const fragment of [
      'UPPER(TRIM(NEW.ASSET_TAG))',
      'UPPER(TRIM(NEW.SERIAL_NUMBER))',
      `,'${sourceType}',`,
      'INSERTINTOASSET_IDENTIFIER_REGISTRY'
    ]) {
      if (!has(fragment)) return `required ${event.toLowerCase()} behavior is missing: ${fragment}`
    }
  }

  if (event === 'UPDATE' || event === 'DELETE') {
    for (const fragment of [
      'DELETEFROMASSET_IDENTIFIER_REGISTRY',
      `SOURCE_TYPE='${sourceType}'`,
      'SOURCE_ID=OLD.ID'
    ]) {
      if (!has(fragment)) return `required ${event.toLowerCase()} cleanup is missing: ${fragment}`
    }
  }

  if (event === 'DELETE' && !has('DELETEFROMASSET_IDENTIFIER_REGISTRYWHERE')) {
    return 'delete trigger does not remove registry claims'
  }

  return null
}

module.exports = { triggerContractFailure }
