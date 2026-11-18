import { useCallback, useEffect, useState } from 'react'
import PagePager from '../components/PagePager.jsx'
import api from '../api'
import { useClmsDialog } from '../components/ClmsDialog.jsx'
import { clearHolidayCache } from '../utils/holidays'
import './Reports.css'
import './RecycleBin.css'

const TYPE_LABELS = { reservations: 'Reservation', users: 'User', laboratories: 'Laboratory', computers: 'Computer', equipment: 'Equipment', maintenance: 'Maintenance', holidays: 'Holiday', teacher_schedules: 'Teacher Schedule' }

function formatDeletedAt(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })
}

// MIS Super Admin only. Data comes from the persistent recycle_bin table; restore runs a server-side
// transaction that re-checks relationships and unique identifiers.
export default function RecycleBin() {
  const { confirm, notify } = useClmsDialog()
  const [selected, setSelected] = useState([])
  const [items, setItems] = useState([])
  const [type, setType] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState({ text: '', error: false })
  const pageSize = 5 // CP187: 5 rows per page; typed page number + Previous / Next
  const [currentPage, setCurrentPage] = useState(1)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const { data } = await api.get('/recycle-bin', { params: type ? { type } : {} })
      setItems(data.items || [])
      setSelected([])
    } catch (error) {
      setMessage({ text: error.response?.data?.message || 'Unable to load the Recycle Bin.', error: true })
    } finally { setLoading(false) }
  }, [type])

  // Initial / filter-change load; state is set when the request resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // One shared restore: single items and batches use the same all-or-nothing server endpoint.
  async function restoreIds(ids, description) {
    if (!await confirm(`Restore ${description}? Related records and unique IDs are re-checked first; if anything conflicts nothing is restored.`, { title: 'Restore records', confirmLabel: 'Restore' })) return
    try {
      const { data } = await api.post('/recycle-bin/restore', { ids })
      setMessage({ text: '', error: false })
      clearHolidayCache()
      await load({ silent: true })
      await notify(data.message || 'Records restored.', { title: 'Successfully restored' })
    } catch (error) {
      setMessage({ text: '', error: false })
      await notify(error.response?.data?.message || 'Unable to restore. Nothing was restored.', { title: 'Restore failed' })
    }
  }
  const restore = item => restoreIds([item.id], item.label || `record #${item.entity_id}`)

  // Permanent delete: always behind a confirmation popup; the server removes the items (and stale Undo snapshots) in one
  // transaction. Nothing is removed on Cancel, and no success message is shown if the server refuses.
  async function permanentDelete(targets) {
    if (!targets.length) return
    const names = targets.slice(0, 3).map(item => item.label || `#${item.entity_id}`).join(', ') + (targets.length > 3 ? ` and ${targets.length - 3} more` : '')
    const what = targets.length === 1 ? names : `${targets.length} selected records (${names})`
    if (!await confirm(`Permanently delete ${what}? This cannot be undone. The record${targets.length === 1 ? '' : 's'} will be removed from the Recycle Bin for good and can no longer be restored.`, { title: 'Permanently delete records', confirmLabel: 'Permanent Delete', danger: true })) return
    try {
      const { data } = await api.post('/recycle-bin/permanent-delete', { ids: targets.map(item => item.id) })
      setMessage({ text: '', error: false })
      clearHolidayCache()
      await load({ silent: true })
      await notify(data.message || 'Records permanently deleted.', { title: 'Permanently deleted' })
    } catch (error) {
      setMessage({ text: '', error: false })
      await notify(error.response?.data?.message || 'Unable to delete permanently. Nothing was deleted.', { title: 'Permanent delete failed' })
    }
  }

  const term = search.trim().toLowerCase()
  const visible = items.filter(item => !term || [item.label, item.entity_type, item.deleted_by_name].some(value => String(value || '').toLowerCase().includes(term)))

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const safePage = Math.min(currentPage, totalPages)
  const firstRecord = visible.length ? (safePage - 1) * pageSize + 1 : 0
  const lastRecord = Math.min(safePage * pageSize, visible.length)
  const allVisibleSelected = visible.length > 0 && visible.every(item => selected.includes(item.id))
  const pageRows = visible.slice((safePage - 1) * pageSize, safePage * pageSize)
  const allPageSelected = pageRows.length > 0 && pageRows.every(item => selected.includes(item.id))
  const selectedItems = items.filter(item => selected.includes(item.id))
  const togglePage = () => setSelected(current => allPageSelected ? current.filter(id => !pageRows.some(item => item.id === id)) : [...new Set([...current, ...pageRows.map(item => item.id)])])

  return <section className="report-page">
    <div className="report-page-heading recycle-heading">
      <h1>Recycle Bin</h1>
    </div>
    <div className="report-card report-results">
      <div className="report-results-toolbar recycle-toolbar">
        <label htmlFor="recycle-type">Type</label>
        <select id="recycle-type" value={type} onChange={event => { setType(event.target.value); setCurrentPage(1) }}>
          <option value="">All records</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}s</option>)}
        </select>
        <input type="search" value={search} onChange={event => { setSearch(event.target.value); setSelected([]); setCurrentPage(1) }} placeholder="Search deleted records" aria-label="Search deleted records" />
        <strong>{visible.length} deleted record{visible.length === 1 ? '' : 's'}</strong>
        <div className="recycle-actions" role="group" aria-label="Recycle Bin actions">
          {/* CP188: one toggle like the Reservations reference */}
          <button type="button" className="report-action-button" onClick={() => setSelected(allVisibleSelected ? [] : visible.map(item => item.id))} disabled={!visible.length}>{allVisibleSelected ? 'Clear Selection' : 'Select All'}</button>
          <button type="button" className="report-action-button" onClick={() => restoreIds(selected, `${selected.length} selected record${selected.length === 1 ? '' : 's'}`)} disabled={!selected.length}>Restore Selected ({selected.length})</button>
          <button type="button" className="report-action-button recycle-danger" onClick={() => permanentDelete(selectedItems)} disabled={!selected.length}>Permanent Delete ({selected.length})</button>
        </div>
      </div>
      {message.text && <div className={`report-state${message.error ? ' error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</div>}
      {loading ? <div className="report-state">Loading</div> : visible.length === 0 ? <div className="report-state">The Recycle Bin is empty.</div> :
        <div className="report-table-wrap"><table className="report-table">
          <thead><tr><th><input type="checkbox" aria-label="Select all records on this page" checked={allPageSelected} onChange={togglePage} /></th><th>Type</th><th>Record</th><th>Deleted By</th><th>Deleted At</th><th>Actions</th></tr></thead>
          <tbody>{pageRows.map(item => <tr key={item.id}>
            <td><input type="checkbox" aria-label={`Select ${item.label}`} checked={selected.includes(item.id)} onChange={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /></td>
            <td>{TYPE_LABELS[item.entity_type] || item.entity_type}</td>
            <td>{item.label || `#${item.entity_id}`}</td>
            <td>{item.deleted_by_name || ''}</td>
            <td>{formatDeletedAt(item.deleted_at)}</td>
            <td className="recycle-row-actions"><button type="button" className="report-action-button" onClick={() => restore(item)}>Restore</button><button type="button" className="report-action-button recycle-danger" onClick={() => permanentDelete([item])}>Permanent Delete</button></td>
          </tr>)}</tbody>
        </table></div>}
      {!loading && visible.length > 0 && <PagePager className="report-pagination" ariaLabel="Recycle Bin pagination" summary={`Showing ${firstRecord}\u2013${lastRecord} of ${visible.length} records`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />}
    </div>
  </section>
}
