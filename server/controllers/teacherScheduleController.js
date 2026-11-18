'use strict'
// CP121: Teacher schedule upload (proof + record keeping).
// Confirmed by the client: Teachers and the MIS Head / Super Admin ('MIS') can upload teacher schedules.
// CP122: MIS Staff (role 'Inventory Staff') can VIEW and DOWNLOAD all schedules for checking/reference only (no upload, no delete).
// CP128: Teacher/Dean/Others may delete only their OWN schedules, MIS Head any; deletion is a soft delete into the Recycle Bin.
// A schedule upload is a reusable record: nothing in the reservation workflow asks for it again.
// CP123: Dean and custom roles (stored as role 'Others') get the same OWN-schedules-only access as Teacher.
//  - Teacher / Dean / Others: upload, list and download ONLY rows where teacher_id = their own account id (taken from the verified session, never from the request).
//  - MIS Staff: list + download all, no upload. MIS Head/Super Admin: upload for any active Teacher, list + download all.
//  - Any other role is refused by every handler here, even if a route were opened by mistake.
// Roles, replacement, size/type and semester rules were NOT specified, so none are invented here:
//  - Teacher uploads for themselves and sees only their own uploads; MIS uploads on behalf of a chosen Teacher and sees all.
//  - Every upload is a separate kept record (no replace, no delete). Files are only ever served as downloads.
const db = require('../database/db.js')
const { logAudit } = require('../utils/auditLogger.js')

// MIS Head / Super Admin and MIS Staff see every teacher's schedules; a Teacher only their own.
const VIEW_ALL_ROLES = ['MIS', 'Inventory Staff']
const OWN_ONLY_ROLES = ['Teacher', 'Dean', 'Others']
const canViewAll = user => VIEW_ALL_ROLES.includes(user?.role)
const canViewOwn = user => OWN_ONLY_ROLES.includes(user?.role)
// CP128: MIS Head manages every teacher's schedules; Teacher / Dean / Others only their OWN (teacher_id = their account id). MIS Staff never deletes.
const canDelete = (user, row) => user?.role === 'MIS' || (canViewOwn(user) && Number(row?.teacher_id) === Number(user.id))
const NOT_AUTHORIZED = { message: 'You are not authorized to access this function.' }

const query = (sql, params = []) => new Promise((resolve, reject) => db.query(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))

function cleanFileName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim()
  return base.slice(-255)
}
const cleanType = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9.+\-\/]/g, '').slice(0, 100) || null

async function listTeachers(request, response) {
  try {
    const rows = await query("SELECT id, full_name, username FROM users WHERE role = 'Teacher' AND status <> 'INACTIVE' ORDER BY full_name")
    response.json({ teachers: rows })
  } catch (error) {
    console.error('Teacher list error:', error.message)
    response.status(500).json({ message: 'Unable to load teachers.' })
  }
}

async function listSchedules(request, response) {
  try {
    if (!canViewAll(request.user) && !canViewOwn(request.user)) return response.status(403).json(NOT_AUTHORIZED)
    const viewAll = canViewAll(request.user)
    const filters = [], params = []
    if (!viewAll) { filters.push('ts.teacher_id = ?'); params.push(request.user.id) }
    else {
      // CP124: a malformed teacher_id (abc, 1.5, -3, repeated ?teacher_id=) is a 400, never passed to the database as NaN/garbage.
      const rawTeacherId = request.query?.teacher_id
      if (rawTeacherId !== undefined && rawTeacherId !== '') {
        const teacherFilter = Number(rawTeacherId)
        if (!['string', 'number'].includes(typeof rawTeacherId) || !Number.isInteger(teacherFilter) || teacherFilter <= 0) return response.status(400).json({ message: 'Invalid teacher.' })
        filters.push('ts.teacher_id = ?'); params.push(teacherFilter)
      }
      // CP122: search by teacher name (existing users.full_name; case-insensitive contains). '!' escapes LIKE wildcards typed by the user.
      const search = String(request.query?.search ?? '').trim().slice(0, 100)
      // CP162: also matches the username.
      if (search) { const like = `%${search.replace(/[!%_]/g, '!$&')}%`; filters.push("(t.full_name LIKE ? ESCAPE '!' OR t.username LIKE ? ESCAPE '!')"); params.push(like, like) }
    }
    const rows = await query(`
      SELECT ts.id, ts.teacher_id, ts.uploaded_by, ts.file_name, ts.file_type, ts.file_size, ts.uploaded_at,
             t.full_name AS teacher_name, t.username AS teacher_username, u.full_name AS uploaded_by_name
      FROM teacher_schedules ts
      LEFT JOIN users t ON t.id = ts.teacher_id
      LEFT JOIN users u ON u.id = ts.uploaded_by
      WHERE ts.deleted_at IS NULL${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
      ORDER BY ts.uploaded_at DESC, ts.id DESC`, params)
    response.json({ schedules: rows.map(row => ({ ...row, can_delete: canDelete(request.user, row) })) })
  } catch (error) {
    console.error('Teacher schedule list error:', error.message)
    response.status(500).json({ message: 'Unable to load teacher schedules.' })
  }
}

// CP162: a PDF upload must have a .pdf name, a PDF (or unspecified) declared type and the %PDF- signature near the start of the bytes.
function isPdfUpload(name, declaredType, data) {
  if (!/\.pdf$/i.test(String(name || ''))) return false
  const declared = String(declaredType ?? '').trim().toLowerCase()
  if (declared && declared !== 'application/pdf' && declared !== 'application/octet-stream') return false
  return data.subarray(0, 1024).toString('latin1').includes('%PDF-')
}

async function uploadSchedule(request, response) {
  try {
    // CP122/CP123: MIS Staff (and any unknown role) may not upload. The route already blocks them; this keeps the controller safe on its own.
    if (request.user.role !== 'MIS' && !canViewOwn(request.user)) return response.status(403).json({ message: 'You are not authorized to upload teacher schedules.' })
    const { fileName, fileType, fileBase64, teacherId } = request.body || {}
    const name = cleanFileName(fileName)
    if (!name) return response.status(400).json({ message: 'Choose a schedule file to upload.' })
    const encoded = String(fileBase64 ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return response.status(400).json({ message: 'The selected file could not be read. Choose it again.' })
    const data = Buffer.from(encoded, 'base64')
    if (!data.length) return response.status(400).json({ message: 'The selected file is empty.' })
    // CP162: PDF only. Checked on the server from the name, the declared type and the real bytes (the client check is only a convenience).
    if (!isPdfUpload(name, fileType, data)) return response.status(400).json({ message: 'Only PDF files can be uploaded.' })

    let teacher
    if (request.user.role !== 'MIS') {
      if (teacherId !== undefined && teacherId !== null && teacherId !== '' && Number(teacherId) !== Number(request.user.id)) return response.status(403).json({ message: 'You can only upload your own schedule.' })
      teacher = { id: request.user.id, full_name: request.user.full_name }
    } else {
      const id = Number(teacherId)
      if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ message: 'Choose the teacher this schedule belongs to.' })
      const rows = await query("SELECT id, full_name FROM users WHERE id = ? AND role = 'Teacher' AND status <> 'INACTIVE'", [id])
      if (!rows.length) return response.status(400).json({ message: 'The selected teacher was not found.' })
      teacher = rows[0]
    }

    const result = await query('INSERT INTO teacher_schedules (teacher_id, uploaded_by, file_name, file_type, file_size, file_data) VALUES (?, ?, ?, ?, ?, ?)', [teacher.id, request.user.id, name, cleanType(fileType), data.length, data])
    logAudit(request.user.id, 'TEACHER SCHEDULE UPLOAD', `Schedule file "${name}" (${data.length} bytes) uploaded for ${teacher.full_name || `teacher #${teacher.id}`}`)
    response.status(201).json({ message: 'Schedule uploaded.', schedule: { id: result.insertId, teacher_id: teacher.id, file_name: name, file_size: data.length } })
  } catch (error) {
    console.error('Teacher schedule upload error:', error.message)
    response.status(500).json({ message: 'Unable to save the schedule. Nothing was uploaded.' })
  }
}

// CP127: only PDF and common raster images may be shown inline. SVG/HTML are excluded on purpose (script risk).
const PREVIEW_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
function previewType(fileName, fileType) {
  const ext = String(fileName || '').split('.').pop().toLowerCase()
  const byExt = PREVIEW_TYPES[ext]
  if (!byExt) return null
  const declared = String(fileType || '').toLowerCase()
  return !declared || declared === 'application/octet-stream' || declared === byExt || (byExt === 'image/jpeg' && declared === 'image/jpg') ? byExt : null
}

async function fetchScheduleFile(request, response) {
  if (!canViewAll(request.user) && !canViewOwn(request.user)) { response.status(403).json(NOT_AUTHORIZED); return null }
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id <= 0) { response.status(400).json({ message: 'Invalid schedule.' }); return null }
  const rows = await query('SELECT teacher_id, file_name, file_type, file_data FROM teacher_schedules WHERE id = ? AND deleted_at IS NULL', [id])
  // A Teacher asking for someone else's file gets the same answer as for a missing one.
  if (!rows.length || (!canViewAll(request.user) && Number(rows[0].teacher_id) !== Number(request.user.id))) { response.status(404).json({ message: 'Schedule not found.' }); return null }
  return rows[0]
}

async function viewSchedule(request, response) {
  try {
    const file = await fetchScheduleFile(request, response)
    if (!file) return
    const type = previewType(file.file_name, file.file_type)
    if (!type) return response.status(415).json({ message: 'Preview unavailable for this file type. Download it instead.' })
    const safeName = String(file.file_name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    response.setHeader('Content-Type', type)
    response.setHeader('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
    response.setHeader('Cache-Control', 'private, no-store')
    response.send(Buffer.isBuffer(file.file_data) ? file.file_data : Buffer.from(file.file_data))
  } catch (error) {
    console.error('Teacher schedule view error:', error.message)
    response.status(500).json({ message: 'Unable to open the schedule.' })
  }
}

async function downloadSchedule(request, response) {
  try {
    if (!canViewAll(request.user) && !canViewOwn(request.user)) return response.status(403).json(NOT_AUTHORIZED)
    const id = Number(request.params.id)
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid schedule.' })
    const rows = await query('SELECT teacher_id, file_name, file_type, file_data FROM teacher_schedules WHERE id = ? AND deleted_at IS NULL', [id])
    // A Teacher asking for someone else's file gets the same answer as for a missing one.
    if (!rows.length || (!canViewAll(request.user) && Number(rows[0].teacher_id) !== Number(request.user.id))) return response.status(404).json({ message: 'Schedule not found.' })
    const file = rows[0]
    const safeName = String(file.file_name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    response.setHeader('Content-Type', file.file_type || 'application/octet-stream')
    response.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'private, no-store')
    response.send(Buffer.isBuffer(file.file_data) ? file.file_data : Buffer.from(file.file_data))
  } catch (error) {
    console.error('Teacher schedule download error:', error.message)
    response.status(500).json({ message: 'Unable to open the schedule.' })
  }
}

// CP128: delete/cancel = soft delete. The row (and file) stay in teacher_schedules with deleted_at set; a metadata-only snapshot goes to the
// existing Recycle Bin (no file bytes copied). Restore/permanent delete live in recycleBinController (type 'teacher_schedules').
async function deleteSchedule(request, response) {
  // Role and id are validated BEFORE any database connection is taken.
  if (request.user?.role !== 'MIS' && !canViewOwn(request.user)) return response.status(403).json({ message: 'You are not authorized to delete teacher schedules.' })
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid schedule.' })
  let connection, transaction = false
  try {
    connection = await new Promise((resolve, reject) => db.getConnection((error, c) => (error ? reject(error) : resolve(c))))
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, result) => (error ? reject(error) : resolve(result))))
    const step = method => new Promise((resolve, reject) => connection[method](error => (error ? reject(error) : resolve())))
    await step('beginTransaction'); transaction = true
    const rows = await run('SELECT id, teacher_id, uploaded_by, file_name, file_type, file_size, uploaded_at FROM teacher_schedules WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id])
    // Someone else's schedule is answered exactly like a missing/already-deleted one.
    if (!rows.length || !canDelete(request.user, rows[0])) { await step('rollback'); transaction = false; return response.status(404).json({ message: 'Schedule not found.' }) }
    const row = rows[0]
    // CP162: only Super Admin (MIS) deletions go to the Recycle Bin. A Teacher/Dean/Others deleting their own schedule removes it for good and writes nothing to the MIS Recycle Bin.
    if (request.user.role !== 'MIS') {
      const removed = await run('DELETE FROM teacher_schedules WHERE id = ? AND deleted_at IS NULL', [id])
      if (Number(removed.affectedRows) !== 1) throw Object.assign(new Error('Schedule changed.'), { httpStatus: 409 })
      await step('commit'); transaction = false
      logAudit(request.user.id, 'TEACHER SCHEDULE DELETE', `Schedule file \"${row.file_name}\" deleted by its owner.`)
      return response.json({ message: 'Schedule deleted.' })
    }
    const snapshot = { id: row.id, teacher_id: row.teacher_id, uploaded_by: row.uploaded_by, file_name: row.file_name, file_type: row.file_type, file_size: row.file_size, uploaded_at: row.uploaded_at == null ? null : String(row.uploaded_at) }
    const marked = await run('UPDATE teacher_schedules SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ? AND deleted_at IS NULL', [request.user.id, id])
    if (Number(marked.affectedRows) !== 1) throw Object.assign(new Error('Schedule changed.'), { httpStatus: 409 })
    const who = (await run('SELECT full_name FROM users WHERE id = ?', [row.teacher_id]))[0]?.full_name || `teacher #${row.teacher_id}`
    snapshot.teacher_name = who
    await run('INSERT INTO recycle_bin (entity_type, entity_id, label, snapshot_json, deleted_by) VALUES (?, ?, ?, ?, ?)', ['teacher_schedules', id, `Schedule: ${row.file_name} (${who})`.slice(0, 255), JSON.stringify(snapshot), request.user.id])
    await step('commit'); transaction = false
    logAudit(request.user.id, 'TEACHER SCHEDULE DELETE', `Schedule file \"${row.file_name}\" of ${who} moved to the Recycle Bin.`)
    response.json({ message: 'Schedule deleted. It was moved to the Recycle Bin.' })
  } catch (error) {
    if (transaction && connection) await new Promise(resolve => connection.rollback(() => resolve()))
    if (error.httpStatus) return response.status(error.httpStatus).json({ message: 'The schedule changed. Refresh and try again.' })
    console.error('Teacher schedule delete error:', error.message)
    response.status(500).json({ message: 'Unable to delete the schedule. Nothing was deleted.' })
  } finally { connection?.release() }
}

// CP162: Undo for a just-completed upload. Only the account that uploaded the file can undo it; it removes that row (an undone upload never existed, so nothing goes to the Recycle Bin).
async function undoUpload(request, response) {
  if (request.user?.role !== 'MIS' && !canViewOwn(request.user)) return response.status(403).json({ message: 'You are not authorized to undo this upload.' })
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ message: 'Invalid schedule.' })
  try {
    const rows = await query('SELECT id, uploaded_by, file_name FROM teacher_schedules WHERE id = ? AND deleted_at IS NULL', [id])
    if (!rows.length || Number(rows[0].uploaded_by) !== Number(request.user.id)) return response.status(404).json({ message: 'Schedule not found.' })
    const removed = await query('DELETE FROM teacher_schedules WHERE id = ? AND uploaded_by = ? AND deleted_at IS NULL', [id, request.user.id])
    if (Number(removed.affectedRows) !== 1) return response.status(404).json({ message: 'Schedule not found.' })
    logAudit(request.user.id, 'TEACHER SCHEDULE UPLOAD UNDONE', `Upload of schedule file \"${rows[0].file_name}\" was undone.`)
    response.json({ message: 'Upload undone. The schedule file was removed.' })
  } catch (error) {
    console.error('Teacher schedule undo error:', error.message)
    response.status(500).json({ message: 'Unable to undo the upload.' })
  }
}

module.exports = { undoUpload, isPdfUpload, listTeachers, listSchedules, uploadSchedule, deleteSchedule, downloadSchedule, viewSchedule, previewType, cleanFileName }
