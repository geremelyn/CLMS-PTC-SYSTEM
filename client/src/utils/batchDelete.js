// Delete All for very long lists: the server accepts at most 5,000 ids per request, so larger lists are sent in sequential
// batches (each batch is its own all-or-nothing transaction on the server). A list of up to one batch is sent as ONE request
// exactly as before. If a later batch fails, the error carries `.partial` (what was already deleted) so nothing is hidden.
export const DELETE_BATCH_SIZE = 1000
export async function postDeleteInBatches(post, ids, extra = {}, batchSize = DELETE_BATCH_SIZE) {
  const batches = []
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize))
  if (batches.length <= 1) { const { data } = await post({ ids, ...extra }); return data }
  const total = { deletedCount: 0, skippedCount: 0, skipped: [], deletedRecords: [], recycleIds: [] }
  for (const batch of batches) {
    try {
      const { data } = await post({ ids: batch, ...extra })
      total.deletedCount += Number(data.deletedCount) || 0; total.skippedCount += Number(data.skippedCount) || 0
      total.skipped.push(...(data.skipped || [])); total.deletedRecords.push(...(data.deletedRecords || [])); total.recycleIds.push(...(data.recycleIds || []))
    } catch (error) {
      // A batch whose reservations all vanished meanwhile (409) is not fatal for the rest of the list.
      if (error?.response?.status === 409 && /exist any more/i.test(error.response?.data?.message || '')) { total.skippedCount += batch.length; continue }
      error.partial = total; throw error
    }
  }
  total.message = `Successfully deleted ${total.deletedCount} reservation${total.deletedCount === 1 ? '' : 's'}.${total.skippedCount ? ` ${total.skippedCount} could not be deleted because they were already deleted by someone else.` : ''}`
  return total
}

// Restore after Delete All uses the same limit, so it is batched the same way.
export async function postRestoreInBatches(post, recycleIds, batchSize = DELETE_BATCH_SIZE) {
  let restored = 0, last = null
  for (let i = 0; i < recycleIds.length; i += batchSize) { const { data } = await post({ ids: recycleIds.slice(i, i + batchSize) }); restored += Number(data.restoredCount) || 0; last = data }
  return recycleIds.length <= batchSize && last ? last : { message: `${restored} record${restored === 1 ? '' : 's'} restored.`, restoredCount: restored }
}
