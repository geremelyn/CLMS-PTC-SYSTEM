const db = require('../database/db.js')

function getAuditLogs(request, response) {
    const conditions = []
    const params = []
    const role = String(request.query?.role || '').trim()
    const from = String(request.query?.from || '').trim()
    const to = String(request.query?.to || '').trim()

    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
    if (role && !['MIS', 'Dean', 'Teacher', 'Inventory Staff'].includes(role)) {
        return response.status(400).json({ message: 'Invalid role filter.' })
    }
    if ((from && !validDate(from)) || (to && !validDate(to))) {
        return response.status(400).json({ message: 'Use valid dates in YYYY-MM-DD format.' })
    }
    if (from && to && from > to) {
        return response.status(400).json({ message: 'The start date must be on or before the end date.' })
    }
    if (role) {
        conditions.push('users.role = ?')
        params.push(role)
    }
    if (validDate(from)) {
        conditions.push('DATE(audit_logs.created_at) >= ?')
        params.push(from)
    }
    if (validDate(to)) {
        conditions.push('DATE(audit_logs.created_at) <= ?')
        params.push(to)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
        SELECT
            audit_logs.id,
            audit_logs.user_id,
            audit_logs.action,
            audit_logs.description,
            audit_logs.created_at,
            users.full_name,
            users.username,
            users.role,
            users.program
        FROM audit_logs
        LEFT JOIN users ON audit_logs.user_id = users.id
        ${where}
        ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
    `

    db.query(sql, params, (error, results) => {
        if (error) {
            console.error('Audit log retrieval error:', error)
            return response.status(500).json({ message: 'Unable to retrieve audit logs' })
        }
        response.json({ auditLogs: results })
    })
}

module.exports = { getAuditLogs }
