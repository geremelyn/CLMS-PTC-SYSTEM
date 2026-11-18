const db = require('../database/db.js')

function logAudit(userId, action, description, callback = () => {}) {
    const sql = `INSERT INTO audit_logs (user_id, action, description) VALUES (?, ?, ?)`
    db.query(sql, [userId ?? null, action, description || null], error => {
        if (error) console.error('Audit log write failed:', error.message)
        callback(error)
    })
}

module.exports = { logAudit }
