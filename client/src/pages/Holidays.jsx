import DatePicker from '../components/DatePicker.jsx'
import PagePager from '../components/PagePager.jsx'
import { useCallback, useEffect, useState } from 'react'
import api from '../api'
import MISPageShell from '../components/MISPageShell'
import { useClmsDialog } from '../components/ClmsDialog.jsx'
import { clearHolidayCache } from '../utils/holidays'
import './Holidays.css'

const TYPES = [
    ['REGULAR', 'Regular Holiday'],
    ['SPECIAL_NON_WORKING', 'Special Non-Working Day'],
    ['SPECIAL_WORKING', 'Special Working Day'],
    ['OTHER', 'Others']
]
const EMPTY = { id: null, holiday_date: '', name: '', holiday_type: 'REGULAR', custom_type_label: '', source: '', is_verified: false }

function manilaYear() {
    return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric' }).format(new Date()))
}
function formatHolidayDate(value) {
    const [year, month, day] = String(value).split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

export default function Holidays() {
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null } })()
    const { confirm, notify, prompt } = useClmsDialog()
    const [year, setYear] = useState(manilaYear())
    const [rows, setRows] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [form, setForm] = useState(null)
    const [formError, setFormError] = useState('')
    const [saving, setSaving] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page; typed page number + Previous / Next
    const [yearText, setYearText] = useState(String(manilaYear()))
    const [selectedIds, setSelectedIds] = useState([])
    const [deleting, setDeleting] = useState(false)

    const load = useCallback(async () => {
        setLoading(true); setError('')
        try {
            const response = await api.get('/holidays', { params: { year } })
            const loaded = response.data.holidays || []
            setRows(loaded)
            setSelectedIds(current => current.filter(id => loaded.some(row => row.id === id && row.is_active)))
        } catch (err) { setError(err.response?.data?.message || 'Unable to load holidays.') }
        finally { setLoading(false) }
    }, [year])

    useEffect(() => { if (user?.role === 'MIS') Promise.resolve().then(load) }, [load, user?.role])

    if (user?.role !== 'MIS') return <div className="holiday-denied"><h1>Access Denied</h1><p>Only the MIS Super Admin may manage holidays.</p></div>

    const openAdd = () => { setFormError(''); setForm({ ...EMPTY, holiday_date: `${year}-01-01` }) }
    const openEdit = row => { setFormError(''); setForm({ id: row.id, holiday_date: row.holiday_date, name: row.name, holiday_type: row.holiday_type, custom_type_label: row.custom_type_label || '', source: row.source || '', is_verified: row.is_verified }) }

    async function save(event) {
        event.preventDefault()
        if (saving) return
        if (form.holiday_type === 'OTHER' && !form.custom_type_label.trim()) { setFormError('Enter the holiday type for Others.'); return }
        if (!await confirm(`${form.id ? 'Save changes to' : 'Add'} “${form.name.trim() || 'this holiday'}” on ${formatHolidayDate(form.holiday_date)}?`, { title: form.id ? 'Save holiday' : 'Add holiday', confirmLabel: 'Save' })) return
        setSaving(true); setFormError('')
        const body = { holiday_date: form.holiday_date, name: form.name, holiday_type: form.holiday_type, custom_type_label: form.holiday_type === 'OTHER' ? form.custom_type_label : '', source: form.source, is_verified: form.is_verified }
        try {
            const response = form.id ? await api.put(`/holidays/${form.id}`, body) : await api.post('/holidays', body)
            clearHolidayCache(); setForm(null)
            const savedYear = Number(String(body.holiday_date).slice(0, 4))
            if (savedYear !== year) setYear(savedYear); else await load()
            await notify(response.data.message || 'Holiday saved.', { title: 'Holiday saved' })
        } catch (err) { setFormError(err.response?.data?.message || 'Unable to save the holiday.') }
        finally { setSaving(false) }
    }

    async function remove(row) {
        if (!await confirm(`Delete “${row.name}” (${formatHolidayDate(row.holiday_date)})? It moves to the Recycle Bin (restore it there). The date becomes bookable again (Sundays stay blocked) and any holiday flags on its reservations are cleared.`, { title: 'Delete holiday', confirmLabel: 'Delete', danger: true })) return
        try {
            await api.delete(`/holidays/${row.id}`)
            clearHolidayCache(); await load()
            await notify(`“${row.name}” was deleted and moved to the Recycle Bin.`, { title: 'Holiday deleted' })
        } catch (err) { await notify(err.response?.data?.message || 'Unable to delete the holiday.', { title: 'Error' }) }
    }

    // Delete All = delete ONLY the selected holidays. Each selected id goes through the existing single-holiday delete
    // (Recycle Bin entry, audit log, reservation-flag sync), so nothing that is not selected can be touched.
    async function deleteSelected() {
        const ids = selectedIds.filter(id => rows.some(row => row.id === id && row.is_active))
        if (!ids.length || deleting) return
        const names = ids.slice(0, 3).map(id => `“${rows.find(row => row.id === id)?.name}”`).join(', ')
        if (!await confirm(`Delete ${ids.length} selected holiday${ids.length === 1 ? '' : 's'}${ids.length <= 3 ? ` (${names})` : ` (${names} and ${ids.length - 3} more)`}? They move to the Recycle Bin (restore them there). Those dates become bookable again (Sundays stay blocked) and their reservation holiday flags are cleared. Holidays that are not selected are not touched.`, { title: 'Delete selected holidays', confirmLabel: 'Delete All', danger: true })) return
        setDeleting(true)
        let done = 0; let firstError = ''
        for (const id of ids) {
            try { await api.delete(`/holidays/${id}`); done += 1 } catch (err) { if (!firstError) firstError = err.response?.data?.message || 'Unable to delete the holiday.' }
        }
        clearHolidayCache(); setSelectedIds([]); await load(); setDeleting(false)
        if (!firstError) await notify(`${done} holiday${done === 1 ? '' : 's'} deleted and moved to the Recycle Bin.`, { title: 'Holidays deleted' })
        else await notify(`${done} of ${ids.length} selected holidays were deleted. ${ids.length - done} could not be deleted: ${firstError}`, { title: 'Error' })
    }

    async function generateDefaults() {
        if (!await confirm(`Add the fixed-date Philippines Holidays for ${year}? They are saved as Unverified. Movable holidays (Holy Week, Chinese New Year, Eid'l Fitr, Eid'l Adha) must be added from the official proclamations.`, { title: `Generate ${year} defaults`, confirmLabel: 'Add defaults' })) return
        try {
            const response = await api.post('/holidays/generate-defaults', { year })
            clearHolidayCache(); await load()
            await notify(response.data.message, { title: 'Defaults added' })
        } catch (err) { await notify(err.response?.data?.message || 'Unable to generate defaults.', { title: 'Error' }) }
    }

    async function changeType(value) {
        if (value !== 'OTHER') { setForm(current => ({ ...current, holiday_type: value, custom_type_label: '' })); return }
        // Others: popup text field with Cancel / Confirm. Cancel keeps the previous type.
        const typed = await prompt('Enter the holiday type:', { title: 'Others', placeholder: 'e.g. Local Founding Day', confirmLabel: 'Confirm' })
        const label = String(typed ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
        if (!label) return
        setForm(current => ({ ...current, holiday_type: 'OTHER', custom_type_label: label }))
    }

    const activeRows = rows.filter(row => row.is_active)
    const totalPages = Math.max(1, Math.ceil(activeRows.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const firstRecord = activeRows.length ? (safePage - 1) * pageSize + 1 : 0
    const lastRecord = Math.min(safePage * pageSize, activeRows.length)
    const pageRows = activeRows.slice((safePage - 1) * pageSize, safePage * pageSize)
    const pageSelectableIds = pageRows.filter(row => row.id && row.is_active).map(row => row.id) // header checkbox = this page only
    const yearOptions = Array.from({ length: 21 }, (_, index) => manilaYear() - 5 + index)
    if (!yearOptions.includes(year)) yearOptions.push(year)
    yearOptions.sort((a, b) => a - b)
    // Searchable year box: type or pick from the suggestions; a valid 4-digit year (2000-2100) applies immediately.
    function onYearText(value) {
        const text = value.replace(/\D/g, '').slice(0, 4); setYearText(text)
        const next = Number(text)
        if (text.length === 4 && next >= 2000 && next <= 2100 && next !== year) { setYear(next); setCurrentPage(1); setSelectedIds([]) }
    }
    const selectableIds = activeRows.filter(row => row.id).map(row => row.id)
    const allHolidaysSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.includes(id))

    return <MISPageShell active="holidays">
        {/* CP147: redundant visible "Holidays" page title removed (the sidebar label and the "PHILIPPINES HOLIDAYS" card label already say it); kept as a visually hidden h1 for screen readers. */}
        <h1 style={{ position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Holidays</h1>
        <section className="holiday-card">
            <div className="holiday-toolbar">
                <div><small>PHILIPPINES HOLIDAYS</small></div>
                <div className="holiday-actions">
                    <button type="button" className="holiday-primary" onClick={openAdd}>Add Holiday</button>
                    <button type="button" onClick={generateDefaults}>Generate {year} Defaults</button>
                    <label className="holiday-year-select"><span>Year</span><input type="text" inputMode="numeric" value={yearText} maxLength={4} placeholder="Search year" aria-label="Year" onChange={event => onYearText(event.target.value)} onBlur={() => setYearText(String(year))} /></label>
                </div>
            </div>
            <div className="holiday-select-actions">
                {selectedIds.length > 0 && <span className="holiday-selected-count">{selectedIds.length} selected</span>}
                {/* CP188: one toggle like the Reservations reference */}
                <button type="button" onClick={() => setSelectedIds(allHolidaysSelected ? [] : selectableIds)} disabled={!selectableIds.length}>{allHolidaysSelected ? 'Clear Selection' : 'Select All'}</button>
                <button type="button" className="danger" onClick={deleteSelected} disabled={!selectedIds.length || deleting}>{deleting ? 'Deleting…' : selectedIds.length ? `Delete (${selectedIds.length})` : 'Delete All'}</button>
            </div>
            {loading && <div className="holiday-state">Loading holidays…</div>}
            {!loading && error && <div className="holiday-state error">{error}<button type="button" onClick={load}>Try Again</button></div>}
            {!loading && !error && <div className="holiday-table-wrap"><table className="holiday-table">
                <thead><tr><th className="holiday-check-col"><input type="checkbox" aria-label="Select all holidays on this page" checked={pageSelectableIds.length > 0 && pageSelectableIds.every(id => selectedIds.includes(id))} disabled={!pageSelectableIds.length} onChange={() => setSelectedIds(current => pageSelectableIds.every(id => current.includes(id)) ? current.filter(id => !pageSelectableIds.includes(id)) : [...new Set([...current, ...pageSelectableIds])])} /></th><th>Date</th><th>Holiday</th><th>Type</th><th>Reservations</th><th>Verification</th><th>Source</th><th>Actions</th></tr></thead>
                <tbody>
                    {pageRows.map(row => <tr key={row.id ?? row.holiday_date}>
                        <td className="holiday-check-col">{row.id ? <input type="checkbox" aria-label={`Select ${row.name}`} checked={selectedIds.includes(row.id)} onChange={() => setSelectedIds(current => current.includes(row.id) ? current.filter(id => id !== row.id) : [...current, row.id])} /> : null}</td>
                        <td>{formatHolidayDate(row.holiday_date)}</td>
                        <td><strong>{row.name}</strong></td>
                        <td><span className={`holiday-chip ${row.holiday_type.toLowerCase()}`}>{row.type_label}</span></td>
                        <td>{row.blocks_reservations ? <span className="holiday-closed">Closed</span> : <span className="holiday-open">Open</span>}</td>
                        <td>{row.is_verified ? <span className="holiday-verified">Verified</span> : <span className="holiday-unverified">Unverified</span>}</td>
                        <td className="holiday-source">{row.source || '—'}</td>
                        <td className="holiday-row-actions">{row.id ? <><button type="button" onClick={() => openEdit(row)}>Edit</button><button type="button" className="danger" onClick={() => remove(row)}>Delete</button></> : '—'}</td>
                    </tr>)}
                    {activeRows.length === 0 && <tr><td colSpan="8" className="holiday-empty">No holidays for {year}. Use “Generate {year} Defaults” or “Add Holiday”.</td></tr>}
                </tbody>
            </table></div>}
            {!loading && !error && activeRows.length > 0 && <PagePager className="report-pagination" ariaLabel="Holiday pagination" summary={`Showing ${firstRecord}–${lastRecord} of ${activeRows.length} holidays`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />}
        </section>
        {form && <div className="holiday-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setForm(null) }}>
            <form className="holiday-modal" role="dialog" aria-modal="true" aria-labelledby="holiday-form-title" onSubmit={save}>
                <h2 id="holiday-form-title">{form.id ? 'Edit Holiday' : 'Add Holiday'}</h2>
                <label>Date<DatePicker restrictDays={false} required title="Holiday date" value={form.holiday_date} onChange={value => setForm({ ...form, holiday_date: value })} /></label>
                <label>Holiday name<input required maxLength={150} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="e.g. Eid'l Adha" /></label>
                <label>Type<select value={form.holiday_type} onChange={event => changeType(event.target.value)}>{TYPES.map(([value, label]) => <option key={value} value={value}>{value === 'OTHER' && form.custom_type_label ? `Others: ${form.custom_type_label}` : label}</option>)}</select></label>
                <label>Source / proclamation<input maxLength={255} value={form.source} onChange={event => setForm({ ...form, source: event.target.value })} placeholder="e.g. Proclamation No. 1264, s. 2026" /></label>
                <label className="holiday-check"><input type="checkbox" checked={form.is_verified} onChange={event => setForm({ ...form, is_verified: event.target.checked })} /> Verified against the official proclamation</label>
                {form.holiday_type !== 'SPECIAL_WORKING' && <p className="holiday-warning">Existing pending/approved reservations on this date will be flagged for review (not deleted).</p>}
                {formError && <p className="holiday-form-error" role="alert">{formError}</p>}
                <div className="holiday-modal-actions"><button type="button" onClick={() => setForm(null)} disabled={saving}>Cancel</button><button type="submit" className="holiday-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
            </form>
        </div>}
    </MISPageShell>
}
