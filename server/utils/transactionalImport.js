function callbackPromise(target, method) {
  return new Promise((resolve, reject) => target[method](error => error ? reject(error) : resolve()))
}
async function runInTransaction(connection, work) {
  await callbackPromise(connection, 'beginTransaction')
  try {
    const result = await work()
    await callbackPromise(connection, 'commit')
    return result
  } catch (error) {
    try { await callbackPromise(connection, 'rollback') } catch (rollbackError) { error.rollbackError = rollbackError }
    throw error
  }
}
module.exports = { runInTransaction }
