const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')
const { requiredText } = require('../utils/recordValidation.js')

const ALLOWED_CATEGORIES = new Set([
  'computer_asset_tag', 'computer_storage_unit', 'computer_storage_type',
  'computer_status', 'computer_condition', 'equipment_type', 'equipment_status', 'equipment_state', 'laboratory_status'
])

// Values already offered by the forms are valid options, but must not be duplicated
// in the custom lookup table under different casing or surrounding whitespace.
const BUILT_IN_OPTIONS = Object.freeze({
  computer_storage_unit: ['GB', 'TB'],
  computer_storage_type: ['HDD', 'SSD'],
  computer_status: ['ACTIVE', 'INACTIVE'],
  computer_condition: ['WORKING', 'NOT WORKING'],
  equipment_type: ['MOUSE', 'KEYBOARD', 'HEADSET', 'PRINTER', 'SCANNER', 'WEBCAM', 'SPEAKER', 'OTHER'],
  equipment_status: ['WORKING', 'ACTIVE', 'INACTIVE', 'NOT WORKING'],
  equipment_state: ['ACTIVE', 'INACTIVE'],
  laboratory_status: ['OPEN', 'USED', 'UNAVAILABLE']
})

// MIS Super Admin manages every option list. MIS Staff (DB role 'Inventory Staff') may use the computer and
// equipment lists (they can now add/edit computers and equipment) but never the laboratory status list.
function canManageOption(role, category) {
  if (role === 'MIS') return true
  if (role === 'Inventory Staff') return category !== 'laboratory_status'
  return false
}

function getOptions(request, response) {
  const category = String(request.query?.category || '').trim().toLowerCase()
  if (!ALLOWED_CATEGORIES.has(category)) return response.status(400).json({ message: 'Unknown option category.' })
  if (!canManageOption(request.user?.role, category)) return response.status(403).json({ message: 'You are not authorized to view options for this field.' })
  db.query('SELECT id, category, value FROM lookup_options WHERE category = ? ORDER BY value', [category], (error, rows) => {
    if (error) {
      console.error('Unable to load lookup options:', error)
      return response.status(500).json({ message: 'Unable to load options.' })
    }
    response.json({ options: rows })
  })
}

function createOption(request, response) {
  const category = String(request.body?.category || '').trim().toLowerCase()
  const value = String(request.body?.value || '').trim()
  if (!ALLOWED_CATEGORIES.has(category)) return response.status(400).json({ message: 'Unknown option category.' })
  if (!canManageOption(request.user?.role, category)) return response.status(403).json({ message: 'You are not authorized to change this configurable option list.' })
  if (!requiredText(value) || value.length > 100) return response.status(400).json({ message: 'Option value is required and must be 100 characters or fewer.' })
  const normalizedValue = value.toLocaleLowerCase()
  if ((BUILT_IN_OPTIONS[category] || []).some(item => item.toLocaleLowerCase() === normalizedValue)) {
    return response.status(409).json({ message: 'That value is already available as a built-in option for this field.' })
  }
  db.query('INSERT INTO lookup_options (category, value, created_by) VALUES (?, ?, ?)', [category, value, request.user?.id ?? null], (error, result) => {
    if (error) {
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ message: 'That option already exists for this field.' })
      console.error('Unable to save lookup option:', error)
      return response.status(500).json({ message: 'Unable to save option.' })
    }
    logAudit(request.user?.id, 'LOOKUP OPTION CREATED', `Added ${category} option: ${value}`)
    response.status(201).json({ message: 'Option added.', option: { id: result.insertId, category, value } })
  })
}

// Where each custom option's value is stored on real records. Values are copied as plain text onto the record,
// so an option row can only be removed when no live record (and no un-restored Recycle Bin snapshot) still uses it.
const USAGE = Object.freeze({
  computer_asset_tag: { table: 'computers', column: 'asset_tag', entity: 'computers', noun: 'computer' },
  computer_storage_unit: { table: 'computers', column: 'storage_unit', entity: 'computers', noun: 'computer' },
  computer_storage_type: { table: 'computers', column: 'storage_type', entity: 'computers', noun: 'computer' },
  computer_status: { table: 'computers', column: 'operational_status', entity: 'computers', noun: 'computer' },
  computer_condition: { table: 'computers', column: 'condition', entity: 'computers', noun: 'computer' },
  equipment_type: { table: 'equipment', column: 'equipment_type', entity: 'equipment', noun: 'equipment record' },
  equipment_status: { table: 'equipment', column: 'status', entity: 'equipment', noun: 'equipment record' },
  equipment_state: { table: 'equipment', column: 'equipment_state', entity: 'equipment', noun: 'equipment record' },
  laboratory_status: { table: 'laboratories', column: 'status_other', entity: 'laboratories', noun: 'laboratory' }
})
const escapeLike = value => String(value).replace(/[\\%_]/g, match => `\\${match}`)
const queryAsync = (sql, values = []) => new Promise((resolve, reject) => db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)))
const firstCount = rows => Number(rows?.[0]?.total ?? rows?.[0]?.count ?? 0)

// Counts live records and Recycle Bin snapshots still holding the value (case-insensitive, matching the column collation).
async function countOptionUsage(category, value) {
  const rule = USAGE[category]
  if (!rule) return { live: 0, recycled: 0 }
  const live = firstCount(await queryAsync(`SELECT COUNT(*) AS total FROM \`${rule.table}\` WHERE \`${rule.column}\` = ?`, [value]))
  const needle = `%${escapeLike(`"${rule.column}":${JSON.stringify(String(value))}`)}%`
  const recycled = firstCount(await queryAsync(
    'SELECT COUNT(*) AS total FROM recycle_bin WHERE restored_at IS NULL AND entity_type = ? AND snapshot_json LIKE ?',
    [rule.entity, needle]
  ))
  return { live, recycled }
}

async function deleteOption(request, response) {
  const id = Number(request.params?.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid option id.' })
  try {
    const rows = await queryAsync('SELECT id, category, value FROM lookup_options WHERE id = ? LIMIT 1', [id])
    const option = rows[0]
    if (!option) return response.status(404).json({ message: 'That custom option no longer exists.' })
    if (!ALLOWED_CATEGORIES.has(option.category)) return response.status(400).json({ message: 'Unknown option category.' })
    if (!canManageOption(request.user?.role, option.category)) return response.status(403).json({ message: 'You are not authorized to delete options for this field.' })
    // Fixed/default options are never rows in lookup_options, but guard anyway so one can never be removed.
    if ((BUILT_IN_OPTIONS[option.category] || []).some(item => item.toLocaleLowerCase() === String(option.value).toLocaleLowerCase())) {
      return response.status(400).json({ message: 'Default options cannot be deleted.' })
    }
    // Computers options: values are stored as plain text on records and Recycle Bin snapshots (no foreign key), so removing
    // a custom dropdown choice never alters history; records keep their value and restores re-insert it unchanged.
    // Equipment and laboratory options follow the same rule (laboratories.status_other is plain text too).
    // CP137: condition lists (computer_condition / equipment_status) are the exception - a custom condition still held by a live asset cannot be deleted.
    const isConditionList = ['computer_condition', 'equipment_status'].includes(option.category)
    if (isConditionList) {
      const usage = await countOptionUsage(option.category, option.value)
      if (usage.live > 0) {
        const rule = USAGE[option.category]
        return response.status(409).json({ message: `“${option.value}” is still used by ${usage.live} existing ${rule.noun}${usage.live === 1 ? '' : 's'}, so it cannot be deleted. Change those records to another condition first.`, inUse: true, usage: { live: usage.live, recycled: 0 } })
      }
    }
    if (!['computer_', 'equipment_', 'laboratory_'].some(prefix => option.category.startsWith(prefix))) {
      const usage = await countOptionUsage(option.category, option.value)
      if (usage.live > 0 || usage.recycled > 0) {
        const rule = USAGE[option.category]
        const parts = []
        if (usage.live > 0) parts.push(`${usage.live} existing ${rule.noun}${usage.live === 1 ? '' : 's'}`)
        if (usage.recycled > 0) parts.push(`${usage.recycled} deleted ${rule.noun}${usage.recycled === 1 ? '' : 's'} in the Recycle Bin`)
        return response.status(409).json({ message: `“${option.value}” is still used by ${parts.join(' and ')}, so it cannot be deleted. Change those records to another option first.`, inUse: true, usage })
      }
    }
    const result = await queryAsync('DELETE FROM lookup_options WHERE id = ? AND category = ? AND value = ?', [option.id, option.category, option.value])
    if (!result?.affectedRows) return response.status(404).json({ message: 'That custom option no longer exists.' })
    logAudit(request.user?.id, 'LOOKUP OPTION DELETED', `Deleted unused ${option.category} option: ${option.value}`)
    response.json({ message: `“${option.value}” was deleted from the dropdown.${['computer_', 'equipment_', 'laboratory_'].some(prefix => option.category.startsWith(prefix)) ? ' Existing records keep their value.' : ''}`, option })
  } catch (error) {
    console.error('Unable to delete lookup option:', error.code || error.message)
    response.status(500).json({ message: 'Unable to delete the option. Nothing was changed.' })
  }
}

module.exports = { getOptions, createOption, deleteOption, countOptionUsage, canManageOption, ALLOWED_CATEGORIES, BUILT_IN_OPTIONS, USAGE }
