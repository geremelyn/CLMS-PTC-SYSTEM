'use strict'
// Wraps mysql2 pool/connection callbacks for ONE request so that an exception thrown
// inside a callback becomes a JSON 500 (with the transaction rolled back and the
// connection released) instead of an uncaught exception that kills the Node process.
function guardDb(db, response, label = 'request') {
  const held = new Set()
  const fail = (error) => {
    console.error(`Unexpected error during ${label}:`, error)
    for (const entry of held) {
      try { entry.rawConnection.rollback(() => entry.release()) } catch { entry.release() }
    }
    held.clear()
    if (!response.headersSent) response.status(500).json({ message: 'Unexpected server error. Please try again.' })
  }
  const guard = (cb) => typeof cb === 'function' ? (...args) => { try { return cb(...args) } catch (error) { fail(error) } } : cb
  const wrapConnection = (raw) => {
    let released = false
    const entry = { rawConnection: raw, release() { if (!released) { released = true; held.delete(entry); raw.release() } } }
    held.add(entry)
    return {
      query: (sql, values, cb) => typeof values === 'function' ? raw.query(sql, guard(values)) : raw.query(sql, values, guard(cb)),
      beginTransaction: (cb) => raw.beginTransaction(guard(cb)),
      commit: (cb) => raw.commit(guard(cb)),
      rollback: (cb) => raw.rollback(guard(cb)),
      release: () => entry.release()
    }
  }
  return {
    query: (sql, values, cb) => typeof values === 'function' ? db.query(sql, guard(values)) : db.query(sql, values, guard(cb)),
    getConnection: (cb) => db.getConnection(guard((error, connection) => error ? cb(error) : cb(null, wrapConnection(connection))))
  }
}
module.exports = { guardDb }
