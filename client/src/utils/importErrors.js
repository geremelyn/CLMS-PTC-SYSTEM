// CP72: turns import validation / request failures into plain-language messages.
// PRESENTATION ONLY: it never changes what the server validates; the server's own message stays visible next to every hint.
const TECHNICAL = /(ER_[A-Z_]+|SQLSTATE|TypeError|ReferenceError|SyntaxError|Unexpected token|undefined|\[object|at [\w.]+ \(|stack|ECONN|ETIMEDOUT)/i

export function explainRowError(raw) {
  const message = String(raw ?? '').trim()
  if (!message) return { kind: 'Problem', message: 'This row could not be checked.', tip: 'Re-check the values in this row.' }
  if (TECHNICAL.test(message)) return { kind: 'Problem', message: 'Something in this row could not be checked.', tip: 'Re-check every value in this row, then choose the file again.' }
  if (/condition note is required/i.test(message)) return { kind: 'Missing required field', message, tip: 'Add a condition note, or change the status/condition to WORKING.' }
  const required = /^(.*?) is required\.?$/i.exec(message)
  if (required) return { kind: 'Missing required field', message, tip: `Fill in the “${required[1].replaceAll('_', ' ')}” column for this row.` }
  if (/duplicates row \d+ in this file|duplicate of an earlier row/i.test(message)) return { kind: 'Repeated in this file', message, tip: 'The same value appears more than once in your file. Remove or change one of the rows.' }
  if (/already exists/i.test(message)) return { kind: 'Already in the system', message, tip: 'A saved record already uses this value. Remove the row or change the value so it is unique.' }
  if (/reached its limit/i.test(message)) return { kind: 'Laboratory is full', message, tip: 'This laboratory already holds its maximum number of computers. Choose another laboratory or raise its capacity first.' }
  if (/does not exist/i.test(message)) return { kind: 'Invalid value', message, tip: 'No saved record matches this value. Check it against the list in the system.' }
  if (/not a configured option/i.test(message)) return { kind: 'Unsupported value', message, tip: 'Use one of the options already offered in the dropdown on that page.' }
  if (/must belong to/i.test(message)) return { kind: 'Invalid value', message, tip: 'Pick a value that belongs to the laboratory in the same row.' }
  if (/password|id number/i.test(message)) return { kind: 'Invalid value', message, tip: 'Check the ID number and Password columns for this row.' }
  if (/must be|invalid|not valid|too long|too short|unsupported/i.test(message)) return { kind: 'Invalid value', message, tip: 'Correct the value in your Excel file.' }
  return { kind: 'Problem', message, tip: '' }
}

export function summarizeRowProblems(rows = []) {
  const counts = new Map(); let bad = 0
  for (const row of rows) { if (row.valid || !row.errors?.length) continue; bad++; for (const kind of new Set(row.errors.map(e => explainRowError(e).kind))) counts.set(kind, (counts.get(kind) || 0) + 1) }
  const parts = [...counts].map(([kind, n]) => `${n} × ${kind.toLowerCase()}`)
  return `${bad} row${bad === 1 ? '' : 's'} need${bad === 1 ? 's' : ''} correction${parts.length ? ` (${parts.join(', ')})` : ''}. Nothing has been saved. Fix the marked rows in your Excel file, then choose it again.`
}

export function describeRowDetails(rows = []) {
  return rows.map(row => `Row ${row.rowNumber}: ${(row.errors || []).map(e => { const x = explainRowError(e); return `${x.kind} — ${x.message}${x.tip ? ` ${x.tip}` : ''}` }).join(' | ')}`).join('\n')
}

// action: 'preview' (checking the file) or 'import' (saving the rows).
export function describeRequestFailure(error, action = 'preview') {
  const checking = action === 'import' ? 'importing' : 'checking'
  const saved = action === 'import' ? 'No rows were saved.' : 'Nothing has been saved.'
  const response = error?.response
  if (!response) {
    const raw = String(error?.message || '')
    if (/unable to read selected workbook/i.test(raw)) return 'The selected file could not be read. Close it in Excel, then choose it again. Nothing has been saved.'
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(raw)) return `The server took too long to respond while ${checking} the file. ${saved} Please try again.`
    return `Can't reach the server. Check your internet/network connection and that CLMS is running, then try again. ${saved}`
  }
  const serverMessage = String(response.data?.message || '').trim()
  if (response.status === 401) return `Your session has expired. Please log in again, then retry. ${saved}`
  if (response.status === 403) return `Your account is not allowed to import into this page. ${saved}`
  if (response.status === 413) return `The workbook is too large to upload. Use a file of 5 MB or smaller. ${saved}`
  if (serverMessage && !TECHNICAL.test(serverMessage)) return /saved/i.test(serverMessage) ? serverMessage : `${serverMessage} ${saved}`
  if (response.status >= 500) return `The server had a problem while ${checking} the file. ${saved} Please try again; if it keeps happening, contact the MIS office.`
  return `The file could not be ${action === 'import' ? 'imported' : 'checked'}. ${saved} Check that it is the CLMS template with the correct columns and try again.`
}
