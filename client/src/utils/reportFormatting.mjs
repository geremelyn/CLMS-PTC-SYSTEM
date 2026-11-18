export function formatReportValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value) ? value.slice(0, 10) : value.replace('T', ' ').split('.')[0]
  return String(value)
}
export function reportRoleLabel(role, program, roleOther) {
  if (role === 'Others') return String(roleOther || '').trim() || 'Others'
  if (role === 'Teacher' && program) return `${program}-Teacher`
  if (role === 'Inventory Staff') return 'MIS Staff'
  return role || '—'
}
export function makeReportViewRows(data, selected, maintenanceKind = null) {
  return data.map(source => {
    const row = { ...source }
    delete row.id
    if (selected === 'reservations' || selected === 'laboratory-usage') {
      row['Reservation Date & Time'] = [formatReportValue(source.reservation_date), `${String(source.start_time || '').slice(0, 5)}–${String(source.end_time || '').slice(0, 5)}`].filter(Boolean).join(' ')
      row['Reserved By'] = [source.reserved_by_username ? `ID: ${source.reserved_by_username}` : '', source.reserved_by, source.reserved_by_program, reportRoleLabel(source.reserved_by_role, source.reserved_by_program, source.reserved_by_role_other)].filter(Boolean).join(' · ') || '—'
      delete row.reservation_date; delete row.start_time; delete row.end_time
      delete row.reserved_by; delete row.reserved_by_username; delete row.reserved_by_role; delete row.reserved_by_role_other; delete row.reserved_by_program
      const ordered = {}
      if (row.laboratory_name !== undefined) ordered.laboratory_name = row.laboratory_name
      ordered['Reservation Date & Time'] = row['Reservation Date & Time']
      for (const [key, value] of Object.entries(row)) if (!['laboratory_name', 'Reservation Date & Time', 'Reserved By'].includes(key)) ordered[key] = value
      ordered['Reserved By'] = row['Reserved By']
      return ordered
    }
    if (selected === 'maintenance') {
      row['Reported By'] = [source.reported_by_username ? `ID: ${source.reported_by_username}` : '', source.reported_by, source.reported_by_program, reportRoleLabel(source.reported_by_role, source.reported_by_program, source.reported_by_role_other)].filter(Boolean).join(' · ') || '—'
      delete row.reported_by; delete row.reported_by_username; delete row.reported_by_role; delete row.reported_by_role_other; delete row.reported_by_program
      // CP59: ids are only used to tell computer records from equipment records; they are not shown.
      delete row.computer_id; delete row.equipment_id
      if (maintenanceKind === 'computers') { delete row.equipment_type; delete row.equipment_asset_tag }
      if (maintenanceKind === 'equipment') { delete row.computer_name; delete row.computer_asset_tag }
      // CP77: Dean/Teacher "My Issue Reports" mixes computer and equipment records, so show ONE asset column set instead of two blank-filled tag columns.
      if (maintenanceKind === 'combined') {
        const isEquipment = source.equipment_id != null
        row['Asset Type'] = isEquipment ? 'Equipment' : 'Computer'
        row['Asset Name'] = (isEquipment ? source.equipment_type : source.computer_name) || '—'
        row['Asset Tag'] = (isEquipment ? source.equipment_asset_tag : source.computer_asset_tag) || '—'
        delete row.computer_name; delete row.computer_asset_tag; delete row.equipment_type; delete row.equipment_asset_tag
      }
      if (source.date_reported !== undefined) { row['Reported Date & Time'] = formatReportValue(source.date_reported); delete row.date_reported }
      return row
    }
    if (selected === 'inventory' || selected === 'damaged-equipment') {
      const serial = [source.asset_tag, source.serial_number].filter(Boolean).join(' / ')
      if (serial) row['Asset Tag / Serial Number'] = serial
      delete row.asset_tag; delete row.serial_number
      return Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a === 'asset_type' ? -1 : b === 'asset_type' ? 1 : 0)))
    }
    if (selected === 'user-accounts') {
      row['ID Number'] = source.username ?? ''
      delete row.username
      row.role = reportRoleLabel(source.role, source.program, source.role_other)
      return row
    }
    return row
  })
}
export function displayReportColumn(column) {
  const overrides = { username: 'ID Number', full_name: 'Name', asset_tag: 'Asset Tag', serial_number: 'Serial Number', role: 'Role', program: 'Program' }
  return overrides[column] || String(column).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
}

// CP59: the Maintenance report is split into Computers / Equipments. A maintenance record references exactly one of them.
export const MAINTENANCE_KINDS = [['computers', 'Computers'], ['equipment', 'Equipments']]
export function filterMaintenanceByKind(data = [], kind = 'computers') {
  return data.filter(row => kind === 'equipment' ? row?.equipment_id != null : row?.computer_id != null)
}
