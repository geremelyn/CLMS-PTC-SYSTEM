const db = require('../database/db.js')
const bcrypt = require('bcrypt')
const { logAudit } = require('../utils/auditLogger.js')
const { validateManagedUser, validManagedUserId, isReservedRoleName } = require('../utils/userValidation.js')

function serverFailure(response, context, error, message) {
  console.error(`${context}:`, error)
  return response.status(500).json({ message })
}

// ---- CP118: custom roles (role "Others" + a role name). The registry keeps the canonical spelling and lets unused roles be deleted. ----
// Registers the name (case-insensitive duplicates reuse the stored spelling) and returns the canonical name.
function registerCustomRole(name) {
  return new Promise((resolve, reject) => {
    db.query('INSERT IGNORE INTO custom_roles (role_name) VALUES (?)', [name], (insertError) => {
      if (insertError) return reject(insertError)
      db.query('SELECT role_name FROM custom_roles WHERE LOWER(role_name) = LOWER(?) ORDER BY id LIMIT 1', [name], (selectError, rows) => selectError ? reject(selectError) : resolve(rows?.[0]?.role_name || name))
    })
  })
}

function getCustomRoles(request, response) {
  db.query(`SELECT r.id, r.role_name, (SELECT COUNT(*) FROM users u WHERE u.role = 'Others' AND LOWER(TRIM(u.role_other)) = LOWER(r.role_name)) AS user_count FROM custom_roles r ORDER BY r.role_name ASC`, (error, rows) => {
    if (error) return serverFailure(response, 'Unable to load custom roles', error, 'Unable to load custom roles.')
    response.json(rows.map(row => ({ id: row.id, role_name: row.role_name, user_count: Number(row.user_count) || 0 })))
  })
}

// DELETE /users/custom-roles/:ref  (ref = custom role id, or a role name). Built-in roles are refused; a role still assigned to any account is refused.
function deleteCustomRole(request, response) {
  const ref = String(request.params.ref ?? '').trim()
  if (!ref) return response.status(400).json({ message: 'Choose a custom role to delete.' })
  let name = null
  if (!/^\d+$/.test(ref)) { try { name = decodeURIComponent(ref) } catch { name = ref } }
  if (name !== null && isReservedRoleName(name)) return response.status(403).json({ message: 'Built-in roles cannot be deleted. Only custom roles can be deleted.' })
  const id = name === null ? Number(ref) : null
  if (id !== null && !validManagedUserId(ref)) return response.status(400).json({ message: 'Invalid custom role.' })
  db.getConnection((connectionError, connection) => {
    if (connectionError) return serverFailure(response, 'Unable to delete custom role', connectionError, 'Unable to delete custom role.')
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, result) => error ? reject(error) : resolve(result)))
    const finish = (status, body) => { connection.release(); return response.status(status).json(body) }
    connection.beginTransaction(async (beginError) => {
      if (beginError) { connection.release(); return serverFailure(response, 'Unable to delete custom role', beginError, 'Unable to delete custom role.') }
      try {
        // The registry row is locked first, so two simultaneous deletes (or a delete racing a re-registration) are serialised.
        const found = await run(id !== null ? 'SELECT id, role_name FROM custom_roles WHERE id = ? FOR UPDATE' : 'SELECT id, role_name FROM custom_roles WHERE LOWER(role_name) = LOWER(?) FOR UPDATE', [id !== null ? id : name])
        if (!found.length) { await run('ROLLBACK'); return finish(404, { message: 'Custom role not found.' }) }
        const role = found[0]
        if (isReservedRoleName(role.role_name)) { await run('ROLLBACK'); return finish(403, { message: 'Built-in roles cannot be deleted. Only custom roles can be deleted.' }) }
        const used = await run("SELECT COUNT(*) AS n FROM users WHERE role = 'Others' AND LOWER(TRIM(role_other)) = LOWER(?) FOR UPDATE", [role.role_name])
        const count = Number(used[0]?.n) || 0
        if (count > 0) { await run('ROLLBACK'); return finish(409, { message: `The custom role "${role.role_name}" is still assigned to ${count} user account${count === 1 ? '' : 's'}. Reassign or remove ${count === 1 ? 'that account' : 'those accounts'} first.`, user_count: count }) }
        await run('DELETE FROM custom_roles WHERE id = ?', [role.id])
        await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve()))
        connection.release()
        logAudit(request.user.id, 'CUSTOM ROLE DELETED', `Deleted custom role "${role.role_name}"`)
        return response.json({ message: `Custom role "${role.role_name}" deleted.` })
      } catch (error) {
        connection.rollback(() => { connection.release(); serverFailure(response, 'Unable to delete custom role', error, 'Unable to delete custom role.') })
      }
    })
  })
}

function getUsers(request, response) {
  db.query(`SELECT id, full_name, surname, first_name, middle_initial, username, role, role_other, program, COALESCE(status, 'ACTIVE') AS status, must_change_password FROM users ORDER BY full_name ASC`, (error, results) => {
    if (error) return serverFailure(response, 'Unable to retrieve users', error, 'Unable to retrieve users.')
    response.json({ users: results })
  })
}

function createUser(request, response) {
  const validation = validateManagedUser(request.body, { passwordRequired: true })
  if (validation.error) return response.status(400).json({ message: validation.error })
  const { full_name, username, password, role, program, role_other: validatedRoleOther, labelOnly, surname, first_name, middle_initial } = validation.values

  db.query('SELECT id FROM users WHERE username = ?', [username], async (checkError, rows) => {
    if (checkError) return serverFailure(response, 'Unable to check username', checkError, 'Unable to check username.')
    if (rows.length) return response.status(409).json({ message: 'Username already exists.' })
    try {
      const hashed = await bcrypt.hash(password, 10)
      const role_other = labelOnly ? await registerCustomRole(validatedRoleOther) : validatedRoleOther // CP118: canonical spelling of an existing custom role
      const insertUser = (withExplicitId = false, explicitId = null) => {
        const sql = withExplicitId
          ? 'INSERT INTO users (id, full_name, username, password, role, status, program, must_change_password, role_other, surname, first_name, middle_initial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          : 'INSERT INTO users (full_name, username, password, role, status, program, must_change_password, role_other, surname, first_name, middle_initial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        const values = withExplicitId
          ? [explicitId, full_name, username, hashed, role, 'ACTIVE', program, ['Dean','Teacher','Others'].includes(role) ? 1 : 0, role_other, surname, first_name, middle_initial]
          : [full_name, username, hashed, role, 'ACTIVE', program, ['Dean','Teacher','Others'].includes(role) ? 1 : 0, role_other, surname, first_name, middle_initial]
        db.query(sql, values, (error, result) => {
          if (!error) {
            const createdId = result.insertId || explicitId
            logAudit(request.user.id, 'ACCOUNT CREATION', `Created ${role} account ${username}`)
            return response.status(201).json({ message: 'User account created successfully.', user: { id: createdId, full_name, surname, first_name, middle_initial, role_other, username, role, program, status: 'ACTIVE', must_change_password: ['Dean','Teacher','Others'].includes(role) } })
          }
          if (!withExplicitId && error.code === 'ER_DUP_ENTRY' && /PRIMARY/i.test(error.message)) {
            return db.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM users', (idError, idRows) => {
              if (idError) return serverFailure(response, 'Unable to prepare new user ID', idError, 'Unable to prepare a new user account.')
              insertUser(true, Math.max(1, Number(idRows[0]?.next_id || 1)))
            })
          }
          if (error.code === 'ER_DUP_ENTRY' && /username/i.test(error.message)) return response.status(409).json({ message: 'Username already exists.' })
          return serverFailure(response, 'Unable to create user', error, 'Unable to create user account.')
        })
      }
      insertUser(false)
    } catch (error) { return serverFailure(response, 'Unable to secure password', error, 'Unable to secure password.') }
  })
}

function updateUser(request, response) {
  const id = Number(request.params.id)
  if (!validManagedUserId(request.params.id, { allowZero: true })) return response.status(400).json({ message: 'Invalid user ID.' })
  const validation = validateManagedUser(request.body)
  if (validation.error) return response.status(400).json({ message: validation.error })
  const { full_name, username, role, program, role_other: validatedRoleOther, surname, first_name, middle_initial } = validation.values
  db.query('SELECT id FROM users WHERE username=? AND id!=?', [username, id], async (checkError, rows) => {
    if (checkError) return serverFailure(response, 'Unable to check username', checkError, 'Unable to check username.')
    if (rows.length) return response.status(409).json({ message: 'Username already exists.' })
    let role_other = validatedRoleOther
    try { if (role === 'Others') role_other = await registerCustomRole(validatedRoleOther) } catch (registerError) { return serverFailure(response, 'Unable to save custom role', registerError, 'Unable to save the custom role.') } // CP118
    db.query(`UPDATE users SET full_name=?, username=?, must_change_password=CASE WHEN role != ? AND ? IN ('Dean','Teacher','Others') THEN 1 ELSE must_change_password END, role=?, status=CASE WHEN ? = 'Others' THEN 'ACTIVE' ELSE status END, program=?, role_other=?, surname=?, first_name=?, middle_initial=? WHERE id=? AND role!='MIS'`, [full_name, username, role, role, role, role, program, role_other, surname, first_name, middle_initial, id], (error, result) => {
      if (error) return serverFailure(response, 'Unable to update user', error, 'Unable to update user.')
      if (!result.affectedRows) return response.status(404).json({ message: 'User not found or MIS account cannot be edited here.' })
      logAudit(request.user.id, 'ACCOUNT MODIFICATION', `Updated account ${username}`)
      response.json({ message: 'User updated successfully.' })
    })
  })
}

function deleteUser(request, response) {
  const id = Number(request.params.id)
  if (!validManagedUserId(request.params.id, { allowZero: true })) return response.status(400).json({ message: 'Invalid user ID.' })
  db.query('SELECT id,username,role FROM users WHERE id=?', [id], (checkError, rows) => {
    if (checkError) return serverFailure(response, 'Unable to check user', checkError, 'Unable to check user.')
    if (!rows.length) return response.status(404).json({ message: 'User not found.' })
    if (rows[0].role === 'MIS') return response.status(400).json({ message: 'MIS account cannot be deleted.' })
    db.query('DELETE FROM users WHERE id=?', [id], (error) => {
      if (error) return serverFailure(response, 'Unable to delete user', error, 'Unable to delete user.')
      logAudit(request.user.id, 'ACCOUNT MODIFICATION', `Deleted account ${rows[0].username}`)
      response.json({ message: 'User deleted successfully.' })
    })
  })
}

function resetPassword(request, response) {
  const id = Number(request.params.id)
  if (!validManagedUserId(request.params.id, { allowZero: true })) return response.status(400).json({ message: 'Invalid user ID.' })
  const new_password = String(request.body?.new_password || '')
  if (new_password.length < 6) return response.status(400).json({ message: 'New password must be at least 6 characters.' })
  bcrypt.hash(new_password, 10).then(hash => {
    db.query('UPDATE users SET password=?, must_change_password=1 WHERE id=? AND role!=\'MIS\'', [hash, id], (error, result) => {
      if (error) return serverFailure(response, 'Unable to reset password', error, 'Unable to reset password.')
      if (!result.affectedRows) return response.status(404).json({ message: 'User not found.' })
      logAudit(request.user.id, 'ACCOUNT MODIFICATION', `Password reset for user #${id}`)
      response.json({ message: 'Password reset successfully.' })
    })
  }).catch(error => serverFailure(response, 'Unable to secure password', error, 'Unable to secure password.'))
}

function setUserStatus(request, response) {
  const id = Number(request.params.id)
  if (!validManagedUserId(request.params.id, { allowZero: true })) return response.status(400).json({ message: 'Invalid user ID.' })
  const status = request.body?.status
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return response.status(400).json({ message: 'Invalid account status.' })
  db.query('UPDATE users SET status=? WHERE id=? AND role!=\'MIS\' ', [status, id], (error, result) => {
    if (error) return serverFailure(response, 'Unable to update account status', error, 'Unable to update account status.')
    if (!result.affectedRows) return response.status(404).json({ message: 'User not found.' })
    logAudit(request.user.id, 'ACCOUNT MODIFICATION', `Account #${id} set to ${status}`)
    response.json({ message: `Account ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully.` })
  })
}

function changeOwnPassword(request, response) {
  const id = Number(request.params.id)
  if (!validManagedUserId(request.params.id, { allowZero: true })) return response.status(400).json({ message: 'Invalid user ID.' })
  const current_password = String(request.body?.current_password || '')
  const new_password = String(request.body?.new_password || '')
  if (id !== Number(request.user.id)) return response.status(403).json({ message: 'You may only change your own password.' })
  if (!current_password || !new_password) return response.status(400).json({ message: 'Current password and new password are required.' })
  if (new_password.length < 6) return response.status(400).json({ message: 'New password must be at least 6 characters.' })
  db.query('SELECT password FROM users WHERE id=?', [id], async (error, rows) => {
    if (error) return serverFailure(response, 'Unable to check user', error, 'Unable to check user.')
    if (!rows.length) return response.status(404).json({ message: 'User not found.' })
    try {
      if (!await bcrypt.compare(current_password, rows[0].password)) return response.status(401).json({ message: 'Current password is incorrect.' })
      const hash = await bcrypt.hash(new_password, 10)
      db.query('UPDATE users SET password=?, must_change_password=0 WHERE id=?', [hash, id], (updateError) => {
        if (updateError) return serverFailure(response, 'Unable to change password', updateError, 'Unable to change password.')
        logAudit(id, 'ACCOUNT MODIFICATION', 'User changed their own password')
        response.json({ message: 'Password changed successfully.' })
      })
    } catch (err) { serverFailure(response, 'Unable to change password', err, 'Unable to change password.') }
  })
}

module.exports = { getUsers, createUser, updateUser, deleteUser, resetPassword, setUserStatus, changeOwnPassword, getCustomRoles, deleteCustomRole, registerCustomRole }
