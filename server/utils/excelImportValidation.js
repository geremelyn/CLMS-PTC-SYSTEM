const { requiredText, positiveInteger } = require('./recordValidation.js')
const COMPUTER_FIELDS = {'computer name':'computer_name','laboratory id':'laboratory_id','laboratory':'laboratory_id','asset tag':'asset_tag','serial number':'serial_number','processor':'processor','ram':'ram','storage capacity':'storage_capacity','storage unit':'storage_unit','storage type':'storage_type','operational status':'operational_status','status':'operational_status','condition':'condition','condition note':'condition_note','notes':'notes'}
const EQUIPMENT_FIELDS = {'equipment type':'equipment_type','laboratory id':'laboratory_id','laboratory':'laboratory_id','computer assignment':'computer_id','computer assignment (id or exact computer name)':'computer_id','computer id':'computer_id','asset tag':'asset_tag','serial number':'serial_number','brand':'brand','model':'model','status':'equipment_state','condition':'status','condition note':'condition_note','notes':'notes'}
const COMPUTER_REQUIRED = ['computer_name','laboratory_id','asset_tag','serial_number','processor','ram','storage_capacity','storage_unit','storage_type','operational_status','condition']
const EQUIPMENT_REQUIRED = ['equipment_type','laboratory_id','asset_tag','serial_number','status']
const DEFAULT_OPTIONS = {computer_storage_unit:['GB','TB'],computer_storage_type:['HDD','SSD'],computer_status:['ACTIVE','INACTIVE'],computer_condition:['WORKING','NOT WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED'],equipment_status:['WORKING','ACTIVE','INACTIVE','NOT WORKING','UNDER REPAIR','DAMAGED','MISSING','RETIRED'],equipment_state:['ACTIVE','INACTIVE']}
function headerKey(value) { return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') }
function mapRow(headers, values, type) {
  const mapping = type === 'computers' ? COMPUTER_FIELDS : EQUIPMENT_FIELDS
  const data = {}
  headers.forEach((header, index) => { const field = mapping[headerKey(header)]; if (field && data[field] === undefined) data[field] = values[index] ?? '' })
  // CP171: equipment has two separate fields. "Status" = Active / Inactive / custom (equipment_state); "Condition" = Working / Not Working / custom (status).
  // BACKWARD COMPATIBILITY: files from before CP171 have a "Status" column holding the CONDITION and no "Condition" column. For those files the old
  // meaning is kept: the value is the condition, except ACTIVE / INACTIVE, which become the Status (condition WORKING, as in the CP164 data migration).
  if (type === 'equipment' && data.equipment_state !== undefined && !headers.some(header => headerKey(header) === 'condition')) {
    const legacy = String(data.equipment_state ?? '').trim().toUpperCase()
    delete data.equipment_state
    if (legacy === 'ACTIVE' || legacy === 'INACTIVE') { data.equipment_state = legacy; data.status = 'WORKING' } else data.status = data.status ?? legacy
  }
  if (type === 'computers' && data.ram !== undefined) { const match = String(data.ram).trim().match(/^(\d+)\s*(?:GB)?$/i); if (match) data.ram = Number(match[1]) }
  return data
}
const text = value => String(value ?? '').trim()
const key = value => text(value).toLocaleLowerCase()
function validateRows(rows, type, reference = {}) {
  const required = type === 'computers' ? COMPUTER_REQUIRED : EQUIPMENT_REQUIRED
  const seenTags = new Map(), seenSerials = new Map()
  const existingTags = new Set((reference.existingTags || []).map(key)), existingSerials = new Set((reference.existingSerials || []).map(key))
  const labs = new Set((reference.laboratories || []).map(row => String(row.id)))
  const labCapacity = new Map((reference.laboratories || []).filter(row => row.capacity != null).map(row => [String(row.id), Number(row.capacity)]))
  const labCount = new Map()
  for (const row of reference.computers || []) labCount.set(String(row.laboratory_id), (labCount.get(String(row.laboratory_id)) || 0) + 1)
  const computers = new Map((reference.computers || []).map(row => [String(row.id), row]))
  const options = Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map(category => [category, [...new Set([...(DEFAULT_OPTIONS[category] || []), ...((reference.options || {})[category] || [])])]]))
  return rows.map((raw, index) => {
    const rowNumber = Number(raw.rowNumber) || index + 2
    const data = { ...(raw.data || raw) }, errors = []
    for (const field of required) if (data[field] == null || String(data[field]).trim() === '') { const label = ({ computer_id: 'computer assignment', laboratory_id: 'laboratory ID', computer_name: 'computer name', equipment_type: 'equipment type', asset_tag: 'asset tag', serial_number: 'serial number', storage_capacity: 'storage capacity', storage_unit: 'storage unit', storage_type: 'storage type', operational_status: 'operational status' })[field] || field.replaceAll('_', ' '); errors.push(`${label} is required.`) }
    if (data.laboratory_id !== undefined && data.laboratory_id !== '') {
      const labId = positiveInteger(data.laboratory_id)
      if (!labId) errors.push('Laboratory ID must be a positive whole number.')
      else if (!labs.has(String(labId))) errors.push(`Laboratory ID ${labId} does not exist.`)
      data.laboratory_id = labId || data.laboratory_id
    }
    if (type === 'computers') {
      for (const field of ['ram','storage_capacity']) { const n = Number(data[field]); if (!Number.isSafeInteger(n) || n <= 0) errors.push(`${field.replaceAll('_',' ')} must be a positive whole number.`); else data[field] = n }
      for (const field of ['computer_name','asset_tag','serial_number','processor','storage_unit','storage_type','operational_status','condition','condition_note']) data[field] = text(data[field])
      for (const field of ['storage_unit','storage_type','operational_status','condition']) data[field] = data[field].toUpperCase()
      for (const [field, category] of [['storage_unit','computer_storage_unit'],['storage_type','computer_storage_type'],['operational_status','computer_status'],['condition','computer_condition']]) {
        const allowed = (options[category] || []).map(v => String(v).toUpperCase())
        if (data[field] && !allowed.includes(data[field])) errors.push(`${field.replaceAll('_',' ')} “${data[field]}” is not a configured option.`)
      }
      if (data.condition && data.condition !== 'WORKING' && !text(data.condition_note)) errors.push('Condition note is required unless condition is WORKING.')
    } else {
      for (const field of ['equipment_type','asset_tag','serial_number','brand','model','status','condition_note']) data[field] = text(data[field])
      data.status = data.status.toUpperCase()
      // Status (separate from Condition): blank / missing column = ACTIVE (existing default). Must be Active, Inactive or a saved custom status.
      data.equipment_state = text(data.equipment_state).toUpperCase() || 'ACTIVE'
      if (data.equipment_state.length > 50) errors.push('Status must be 50 characters or fewer.')
      else if (!(options.equipment_state || []).map(v => String(v).toUpperCase()).includes(data.equipment_state)) errors.push(`Status “${data.equipment_state}” is not a configured option. Use ACTIVE, INACTIVE or a custom status saved on the Equipment page.`)
      const requestedComputer = text(data.computer_id)
      let computerId = null
      if (requestedComputer) {
        const namedComputer = [...computers.values()].find(item => String(item.computer_name || '').trim().toLocaleLowerCase() === requestedComputer.toLocaleLowerCase())
        computerId = positiveInteger(data.computer_id) || (namedComputer ? Number(namedComputer.id) : null)
        const computer = computers.get(String(computerId || ''))
        if (!computerId) errors.push('Computer assignment must be a positive computer ID or an exact computer name.')
        else if (!computer) errors.push(`Computer assignment ${data.computer_id} does not exist.`)
        else if (computer && Number(computer.laboratory_id) !== Number(data.laboratory_id)) errors.push('Computer assignment must belong to the selected laboratory.')
      }
      if (data.status && !(options.equipment_status || []).map(v => String(v).toUpperCase()).includes(data.status)) errors.push(`Condition “${data.status}” is not a configured option.`)
      if (data.status && !['WORKING', 'ACTIVE', 'INACTIVE'].includes(data.status) && !text(data.condition_note)) errors.push('Condition note is required unless status is WORKING, ACTIVE or INACTIVE.')
      data.computer_id = computerId
    }
    // Same rule as the Add/Edit forms: a laboratory cannot hold more computers than its capacity (existing + earlier rows in this file).
    if (type === 'computers' && labs.has(String(data.laboratory_id)) && labCapacity.has(String(data.laboratory_id))) {
      const labKey = String(data.laboratory_id), used = labCount.get(labKey) || 0
      if (used >= labCapacity.get(labKey)) errors.push('Laboratory reached its limit.'); else labCount.set(labKey, used + 1)
    }
    const tag = key(data.asset_tag), serial = key(data.serial_number)
    if (tag && existingTags.has(tag)) errors.push(`Asset tag “${data.asset_tag}” already exists in the database.`)
    if (serial && existingSerials.has(serial)) errors.push(`Serial number “${data.serial_number}” already exists in the database.`)
    if (tag && seenTags.has(tag)) errors.push(`Asset tag duplicates row ${seenTags.get(tag)} in this file.`); else if (tag) seenTags.set(tag, rowNumber)
    if (serial && seenSerials.has(serial)) errors.push(`Serial number duplicates row ${seenSerials.get(serial)} in this file.`); else if (serial) seenSerials.set(serial, rowNumber)
    for (const field of Object.keys(data)) if (typeof data[field] === 'string') data[field] = data[field].trim()
    return { rowNumber, data, errors, valid: errors.length === 0 }
  })
}
module.exports = { COMPUTER_FIELDS, EQUIPMENT_FIELDS, COMPUTER_REQUIRED, EQUIPMENT_REQUIRED, mapRow, validateRows, headerKey }
