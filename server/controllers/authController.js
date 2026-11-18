const db = require('../database/db.js')
const bcrypt = require('bcrypt')
const { logAudit } = require('../utils/auditLogger.js')
const { createSessionToken, revokeSessionToken } = require('../utils/sessionToken.js')

function login (request, response) {
    const { username, password } = request.body
  

  if (!username || !password) {
    return response.status(400).json({
      message: 'Username and password are required'
    })
  }

  db.query(
    'SELECT * FROM users WHERE username = ?',
    [username],
    async (error, results) => {
      if (error) {
        console.error('Query error:', error.message)

        return response.status(500).json({
          message: 'Database query failed'
        })
      }

      if (results.length === 0) {
        return response.status(401).json({
          message: 'Invalid username or password'
        })
      }

      const user = results[0]

      if (user.status === 'INACTIVE') {
        return response.status(403).json({ message: 'This account is inactive. Please contact MIS.' })
      }

        const passwordMatches = await bcrypt.compare(
        password,
        user.password
        )

        if (!passwordMatches) {
        return response.status(401).json({
            message: 'Invalid username or password'
        })
        }

      logAudit(user.id, 'USER LOGIN', `User ${user.username} logged in`)

      return response.status(200).json({
        message: 'Login successful',
        token: createSessionToken(user.id),
        user: {
          id: user.id,
          full_name: user.full_name,
          surname: user.surname || null,
          first_name: user.first_name || null,
          middle_initial: user.middle_initial || null,
          username: user.username,
          role: user.role,
          program: user.program || null,
          role_other: user.role === 'Others' ? (user.role_other || null) : null,
          must_change_password: Boolean(user.must_change_password)
        }
      })
    }
  )
}
module.exports = {login}
function logout(request, response) {
  const userId = request.user?.id ?? null
  revokeSessionToken(request.authToken, (revokeError) => {
    logAudit(userId, 'USER LOGOUT', 'User logged out')
    if (revokeError) {
      return response.status(503).json({ message: 'Signed out locally, but persistent session revocation could not be saved. Please contact MIS if this persists.' })
    }
    return response.json({ message: 'Logout recorded.' })
  })
}

module.exports.logout = logout
