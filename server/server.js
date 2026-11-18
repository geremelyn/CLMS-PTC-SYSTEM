const express = require('express')
const cors = require('cors')
const { ensureSchema } = require('./database/ensureSchema.js')
const db = require('./database/db.js')
const RESERVATION_POLICY = require('./config/reservationPolicy.js')

const app = express()
const PORT = Number(process.env.PORT || 5000)

app.use(cors({ origin: true, credentials: false }))
app.use(express.json({ limit: '16mb' }))

app.get('/', (request, response) => response.send('CLMS server is working'))
app.get('/api/test', (request, response) => response.json({ message: 'React and Express are connected' }))
app.get('/api/health', (request, response) => {
    db.query('SELECT DATABASE() AS database_name, 1 AS database_ok', (error, rows) => {
        if (error) return response.status(503).json({ ok: false, message: error.message })
        response.json({ ok: true, version: 'CLMS-MERGED-2026-10', database: rows[0]?.database_name || null })
    })
})

app.get('/api/diagnostics', (request, response) => {
    const required = {
        users: ['id','full_name','username','password','role','status','program'],
        laboratories: ['id','laboratory_name','capacity','status','available_from','available_until','booking_interval'],
        computers: ['id','computer_name','laboratory_id','asset_tag','serial_number','operational_status','condition','condition_note'],
        equipment: ['id','equipment_type','laboratory_id','computer_id','asset_tag','serial_number','status','condition_note','reported_by','report_date'],
        reservations: ['id','laboratory_id','reserved_by','reservation_date','start_time','end_time','purpose','status','cancellation_note','decision_note','decided_by','decided_at','subject_name','professor_name','created_at'],
        maintenance: ['id','computer_id','equipment_id','reported_by','issue_description','status','maintenance_note','date_reported','date_resolved'],
        undo_actions: ['id','entity_type','snapshot_json','created_by','created_at','expires_at','used_at'],
        audit_logs: ['id','user_id','action','description','created_at'],
        lookup_options: ['id','category','value','created_by','created_at']
    }
    const result = {}
    let pending = Object.keys(required).length
    let failed = false
    for (const table of Object.keys(required)) {
        db.query(`SHOW COLUMNS FROM \`${table}\``, (error, rows) => {
            if (error) { result[table] = { ok: false, error: error.message }; failed = true }
            else { const names = rows.map(r => r.Field); result[table] = { ok: required[table].every(c => names.includes(c)), missing: required[table].filter(c => !names.includes(c)), columns: names, auto_increment_id: rows.find(r => r.Field === 'id')?.Extra?.includes('auto_increment') || false } }
            pending -= 1
            if (!pending) response.status(failed ? 500 : 200).json({ ok: !failed && Object.values(result).every(v => v.ok), version: 'CLMS-MERGED-2026-10', tables: result })
        })
    }
})

app.use('/api/dashboard', require('./routes/dashboardRoutes.js'))
app.use('/api/auth', require('./routes/authRoutes.js'))
app.use('/api/laboratories', require('./routes/laboratoryRoutes.js'))
app.use('/api/computers', require('./routes/computerRoutes.js'))
app.use('/api/equipment', require('./routes/equipmentRoutes.js'))
app.use('/api/options', require('./routes/lookupOptionRoutes.js'))
app.use('/api/maintenance', require('./routes/maintenanceRoutes.js'))
app.use('/api/reservations', require('./routes/reservationRoutes.js'))
app.use('/api/teacher-schedules', require('./routes/teacherScheduleRoutes.js'))
app.use('/api/holidays', require('./routes/holidayRoutes.js'))
app.use('/api/users', require('./routes/userRoutes.js'))
app.use('/api/reports', require('./routes/reportRoutes.js'))
app.use('/api/audit-logs', require('./routes/auditLogRoutes.js'))
app.use('/api/recycle-bin', require('./routes/recycleBinRoutes.js'))
app.use('/api/undo', require('./routes/undoRoutes.js'))

app.use((error, request, response, next) => {
    console.error('Unhandled API error:', error)
    if (response.headersSent) return next(error)
    if (error?.type === 'entity.too.large') {
        const isImport = String(request.path || '').includes('/import-preview')
        return response.status(413).json({ message: isImport ? 'Workbook request is too large. Choose an .xlsx file no larger than 5 MB.' : 'Request body is too large.' })
    }
    response.status(500).json({ message: 'Unexpected server error.' })
})

async function start() {
    try {
        await ensureSchema()
        app.listen(PORT, () => {
            console.log(`CLMS API running at http://localhost:${PORT}`)
        })
    } catch (error) {
        console.error('Database initialization failed:', error.message)
        console.error('The API was NOT started because the database is not ready.')
        process.exitCode = 1
    }
}

start()
