const crypto = require('crypto')

// A stable secret should be configured in the server environment for deployments.
// The fallback intentionally invalidates all outstanding tokens after a process restart.
const secret = process.env.CLMS_SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const revokedTokens = new Set()
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

function tokenHash(token) {
    return crypto.createHash('sha256').update(token).digest('hex')
}

function tokenExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
        return Number.isInteger(payload.exp) ? new Date(payload.exp * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
    } catch {
        return new Date()
    }
}

function createSessionToken(userId) {
    const payload = Buffer.from(JSON.stringify({
        sub: Number(userId),
        exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS
    })).toString('base64url')
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
    return `${payload}.${signature}`
}

function verifySessionToken(token) {
    if (typeof token !== 'string' || !token || revokedTokens.has(token)) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, suppliedSignature] = parts
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest()
    let suppliedBytes
    try { suppliedBytes = Buffer.from(suppliedSignature, 'base64url') } catch { return null }
    if (suppliedBytes.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedBytes, expectedSignature)) return null
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        if (!Number.isInteger(data.sub) || data.sub < 0 || !Number.isInteger(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null
        return { userId: data.sub }
    } catch {
        return null
    }
}

function revokeSessionToken(token, callback = () => {}) {
    if (typeof token !== 'string' || !token) return callback(null)
    revokedTokens.add(token)
    const expiry = tokenExpiry(token)
    const db = require('../database/db.js')
    db.query(
        `INSERT INTO session_revocations (token_hash, expires_at) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)`,
        [tokenHash(token), expiry],
        error => {
            if (error) console.error('Persistent session revocation failed:', error.message)
            callback(error || null)
        }
    )
}

module.exports = { createSessionToken, verifySessionToken, revokeSessionToken, tokenHash }
