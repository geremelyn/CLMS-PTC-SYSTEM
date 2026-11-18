const mysql = require('mysql2')

// Keep the project's established database settings; use a pool so each reservation
// transaction gets its own connection and concurrent requests cannot share a transaction.
if (process.env.DB_PASSWORD === undefined) console.warn('DB_PASSWORD is not set. Create server/.env (see server/.env.example) if your MySQL user needs a password.')
const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME || 'ptc_clms',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    timezone: '+08:00'
})

db.getConnection((error, connection) => {
    if (error) {
        console.error('MySQL/MariaDB connection failed:', error.message)
        console.error('Make sure MySQL/MariaDB is running and the database "ptc_clms" exists.')
        return
    }
    console.log('Connected to MySQL/MariaDB:', process.env.DB_NAME || 'ptc_clms')
    connection.release()
})

module.exports = db
