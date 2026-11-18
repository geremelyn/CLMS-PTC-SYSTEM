// Builds the success text shown AFTER a delete really succeeded (server confirmed). Uses the record information returned
// by the server: "[Record information] moved to the recycle bin and can be undone anytime."
export function deletedMessage(data, fallback = 'Successfully deleted.') {
  const records = Array.isArray(data?.deletedRecords) ? data.deletedRecords : []
  if (!records.length) return data?.message || fallback
  const describe = record => `${record.label}${record.details ? ` (${record.details})` : ''}`
  const shown = records.slice(0, 5).map(describe)
  // The server (and batched Delete All) may return only a few record details: count the REAL total, not the list length.
  const total = Math.max(records.length, Number(data?.deletedCount) || 0)
  const extra = total > 5 ? ` and ${total - 5} more` : ''
  const count = Number(data?.skippedCount) || 0
  const list = Array.isArray(data?.skipped) ? data.skipped : []
  // Use the server's real reasons (still in use / already deleted by someone else) - never a guessed one.
  const detail = list.slice(0, 3).map(item => `${item.label}: ${item.reason}`).join(' ')
  const skipped = count > 0 ? `\n${count} record${count === 1 ? ' was' : 's were'} skipped and not deleted.${detail ? ` ${detail}${list.length > 3 ? ` (and ${list.length - 3} more)` : ''}` : ''}` : ''
  return `${shown.join(', ')}${extra} moved to the recycle bin and can be undone anytime.${skipped}`
}
