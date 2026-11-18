const db = require('../database/db.js')
const { verifySessionToken, tokenHash } = require('../utils/sessionToken.js')

function requireRole(...allowedRoles) {
    return (request, response, next) => {
        const authorization = String(request.header('authorization') || '')
        const match = authorization.match(/^Bearer\s+(.+)$/i)
        const token = match?.[1]
        const session = verifySessionToken(token)
        if (!session) return response.status(401).json({ message: 'Authentication required. Please sign in again.' })

        db.query('SELECT token_hash FROM session_revocations WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1', [tokenHash(token)], (revokeError, revokedRows) => {
            if (revokeError) return response.status(503).json({ message: 'Unable to verify session revocation status. Please try again.' })
            if (revokedRows.length) return response.status(401).json({ message: 'This session has been revoked. Please sign in again.' })
            db.query('SELECT id, full_name, username, role, status FROM users WHERE id=?', [session.userId], (error, rows) => {
                if (error) return response.status(500).json({ message: 'Unable to verify access.' })
                if (!rows.length) return response.status(401).json({ message: 'User session is invalid.' })
                const user = rows[0]
                if (user.status === 'INACTIVE') return response.status(403).json({ message: 'This account is inactive.' })
                if (allowedRoles.length && !allowedRoles.includes(user.role)) return response.status(403).json({ message: 'You are not authorized to access this function.' })
                request.user = user
                request.authToken = token
                next()
            })
        })
    }
}
module.exports = { requireRole }
