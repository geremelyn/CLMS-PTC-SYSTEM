function normalizeRecordIds(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  const seen = new Set()
  for (const item of value) {
    if ((typeof item !== 'number' && typeof item !== 'string') || String(item).trim() === '' || !/^\d+$/.test(String(item).trim())) return []
    const id = Number(item)
    if (!Number.isSafeInteger(id) || id <= 0) return []
    if (!seen.has(id)) { seen.add(id); ids.push(id) }
  }
  return ids
}
module.exports = { normalizeRecordIds }
