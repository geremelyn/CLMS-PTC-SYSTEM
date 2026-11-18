const db = require('../database/db.js')
const { validateLaboratoryFilter, validateAuditReportFilters } = require('../utils/reportValidation.js')

function query(sql, params = []) {
  return new Promise((resolve, reject) => db.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)))
}

function laboratoryFilter(request, alias) {
  const validation = validateLaboratoryFilter(request.query?.laboratory_id)
  if (validation.error) return { error: validation.error, sql: '', params: [] }
  if (validation.id == null) return { error: null, sql: '', params: [] }
  return { error: null, sql: ` AND ${alias} = ?`, params: [validation.id] }
}

async function getLaboratoryUsageReport(request, response) {
  try {
    const filter = laboratoryFilter(request, 'r.laboratory_id')
    if (filter.error) return response.status(400).json({ message: filter.error })
    const rows = await query(`
      SELECT r.id, l.laboratory_name, r.reservation_date, r.start_time, r.end_time,
             r.purpose, r.subject_name, r.professor_name, r.status, u.full_name AS reserved_by, u.username AS reserved_by_username, u.role AS reserved_by_role, u.role_other AS reserved_by_role_other, u.program AS reserved_by_program
      FROM reservations r
      LEFT JOIN laboratories l ON r.laboratory_id = l.id
      LEFT JOIN users u ON r.reserved_by = u.id
      WHERE 1=1 ${filter.sql}
      ORDER BY r.reservation_date DESC, r.start_time DESC
    `, filter.params)
    response.json({ report: rows })
  } catch (error) {
    console.error('Laboratory usage report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

async function getReservationReport(request, response) {
  try {
    const filter = laboratoryFilter(request, 'r.laboratory_id')
    if (filter.error) return response.status(400).json({ message: filter.error })
    const rows = await query(`
      SELECT r.id, l.laboratory_name, r.reservation_date, r.start_time, r.end_time,
             r.purpose, r.subject_name, r.professor_name, r.status, r.cancellation_note, r.decision_note,
             u.full_name AS reserved_by, u.username AS reserved_by_username, u.role AS reserved_by_role, u.role_other AS reserved_by_role_other, u.program AS reserved_by_program, r.created_at
      FROM reservations r
      LEFT JOIN laboratories l ON r.laboratory_id = l.id
      LEFT JOIN users u ON r.reserved_by = u.id
      WHERE 1=1 ${filter.sql}
      ORDER BY r.reservation_date DESC, r.start_time DESC
    `, filter.params)
    response.json({ report: rows })
  } catch (error) {
    console.error('Reservation report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

async function getInventoryReport(request, response) {
  try {
    const computerFilter = laboratoryFilter(request, 'c.laboratory_id')
    if (computerFilter.error) return response.status(400).json({ message: computerFilter.error })
    const computers = await query(`
      SELECT c.id, c.computer_name AS asset_name, c.asset_tag, c.serial_number,
             l.laboratory_name, c.operational_status, c.\`condition\`, c.condition_note
      FROM computers c
      LEFT JOIN laboratories l ON c.laboratory_id = l.id
      WHERE 1=1 ${computerFilter.sql}
      ORDER BY c.computer_name
    `, computerFilter.params)
    const equipmentFilter = laboratoryFilter(request, 'e.laboratory_id')
    if (equipmentFilter.error) return response.status(400).json({ message: equipmentFilter.error })
    const equipment = await query(`
      SELECT e.id, e.equipment_type AS asset_name, e.asset_tag, e.serial_number,
             l.laboratory_name, e.status AS asset_condition, e.condition_note, reporter.full_name AS reported_by, e.report_date
      FROM equipment e
      LEFT JOIN laboratories l ON e.laboratory_id = l.id
      LEFT JOIN users reporter ON e.reported_by = reporter.id
      WHERE 1=1 ${equipmentFilter.sql}
      ORDER BY e.equipment_type
    `, equipmentFilter.params)
    const report = [
      ...computers.map(row => ({ asset_type: 'COMPUTER', ...row })),
      ...equipment.map(row => ({ asset_type: 'EQUIPMENT', ...row }))
    ]
    response.json({ report })
  } catch (error) {
    console.error('Inventory report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

// Dean, Teacher and custom roles (Others) may only ever read maintenance reports THEY submitted (m.reported_by = their own id).
const OWN_REPORT_ROLES = ['Dean', 'Teacher', 'Others']

async function getMaintenanceReport(request, response) {
  try {
    const filter = laboratoryFilter(request, 'COALESCE(c.laboratory_id, e.laboratory_id)')
    if (filter.error) return response.status(400).json({ message: filter.error })
    const rows = await query(`
      SELECT m.id, m.computer_id, m.equipment_id, m.date_reported, m.date_resolved, m.status, m.issue_description, m.maintenance_note,
             l.laboratory_name,
             u.full_name AS reported_by, u.username AS reported_by_username, u.role AS reported_by_role, u.role_other AS reported_by_role_other, u.program AS reported_by_program,
             c.computer_name, c.asset_tag AS computer_asset_tag,
             e.equipment_type, e.asset_tag AS equipment_asset_tag
      FROM maintenance m
      LEFT JOIN users u ON m.reported_by = u.id
      LEFT JOIN computers c ON m.computer_id = c.id
      LEFT JOIN equipment e ON m.equipment_id = e.id
      LEFT JOIN laboratories l ON l.id = COALESCE(c.laboratory_id, e.laboratory_id)
      WHERE 1=1 ${filter.sql}${OWN_REPORT_ROLES.includes(request.user?.role) ? ' AND m.reported_by = ?' : ''}
      ORDER BY m.date_reported DESC
    `, [...filter.params, ...(OWN_REPORT_ROLES.includes(request.user?.role) ? [request.user.id] : [])])
    response.json({ report: rows })
  } catch (error) {
    console.error('Maintenance report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

async function getDamagedEquipmentReport(request, response) {
  try {
    const computerFilter = laboratoryFilter(request, 'c.laboratory_id')
    if (computerFilter.error) return response.status(400).json({ message: computerFilter.error })
    const computers = await query(`
      SELECT c.computer_name AS asset_name, c.asset_tag, c.serial_number,
             l.laboratory_name, c.\`condition\`, c.condition_note
      FROM computers c
      LEFT JOIN laboratories l ON c.laboratory_id = l.id
      WHERE c.\`condition\` = 'DAMAGED' ${computerFilter.sql}
      ORDER BY c.computer_name
    `, computerFilter.params)
    const equipmentFilter = laboratoryFilter(request, 'e.laboratory_id')
    if (equipmentFilter.error) return response.status(400).json({ message: equipmentFilter.error })
    const equipment = await query(`
      SELECT e.equipment_type AS asset_name, e.asset_tag, e.serial_number,
             l.laboratory_name, e.status AS asset_condition, e.condition_note, reporter.full_name AS reported_by, e.report_date
      FROM equipment e
      LEFT JOIN laboratories l ON e.laboratory_id = l.id
      LEFT JOIN users reporter ON e.reported_by = reporter.id
      WHERE e.status = 'DAMAGED' ${equipmentFilter.sql}
      ORDER BY e.equipment_type
    `, equipmentFilter.params)
    response.json({
      report: [
        ...computers.map(row => ({ asset_type: 'COMPUTER', ...row })),
        ...equipment.map(row => ({ asset_type: 'EQUIPMENT', ...row }))
      ]
    })
  } catch (error) {
    console.error('Damaged equipment report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

async function getUserAccountsReport(request, response) {
  try {
    const rows = await query("SELECT id, CASE WHEN role='MIS' THEN 'Super Admin' ELSE full_name END AS full_name, username, role AS role, role_other, program, status FROM users ORDER BY role, full_name")
    response.json({ report: rows })
  } catch (error) {
    console.error('User accounts report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

async function getAuditLogReport(request, response) {
  try {
    const validation = validateAuditReportFilters(request.query)
    if (validation.error) return response.status(400).json({ message: validation.error })
    const { role, userId, from, to } = validation.filters
    const conditions = []
    const params = []
    if (role) { conditions.push('u.role = ?'); params.push(role) }
    if (userId != null) { conditions.push('a.user_id = ?'); params.push(userId) }
    if (from) { conditions.push('DATE(a.created_at) >= ?'); params.push(from) }
    if (to) { conditions.push('DATE(a.created_at) <= ?'); params.push(to) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await query(`
      SELECT a.id, a.action, a.description, a.created_at,
             u.full_name, u.username, u.role
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      ${where}
      ORDER BY a.created_at DESC
    `, params)
    response.json({ report: rows })
  } catch (error) {
    console.error('Audit log report:', error.message)
    response.status(500).json({ message: 'Unable to generate report. Please try again later.' })
  }
}

module.exports = {
  getLaboratoryUsageReport,
  getReservationReport,
  getInventoryReport,
  getMaintenanceReport,
  getDamagedEquipmentReport,
  getUserAccountsReport,
  getAuditLogReport
}
