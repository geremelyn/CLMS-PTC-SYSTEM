const db = require('../database/db.js')

function getTotalUsers(request, response) {
    db.query('SELECT COUNT(*) AS totalUsers FROM users', (error, results) => {
        if (error) return response.status(500).json({ message: 'Unable to retrieve total users' })
        response.json({ totalUsers: results[0].totalUsers })
    })
}

function getManilaDateString(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
}

function getMISStats(request, response) {
    const sql = `
        SELECT
            (SELECT COUNT(*) FROM laboratories) AS laboratories,
            (SELECT COUNT(*) FROM computers) AS computers,
            (SELECT COUNT(*) FROM reservations WHERE status = 'PENDING') AS pendingReservations,
            (SELECT COUNT(*) FROM reservations WHERE reservation_date = ? AND status IN ('APPROVED','COMPLETED')) AS todayReservations
    `
    db.query(sql, [getManilaDateString()], (error, results) => {
        if (error) {
            console.error('MIS dashboard stats error:', error)
            return response.status(500).json({ message: 'Unable to retrieve dashboard statistics' })
        }
        response.json({ stats: results[0] })
    })
}

module.exports = { getTotalUsers, getMISStats }
