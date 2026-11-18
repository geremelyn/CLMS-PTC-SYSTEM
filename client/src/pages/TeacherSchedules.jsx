import { useEffect, useRef, useState } from 'react'
import api from '../api'
import { useClmsDialog } from '../components/ClmsDialog.jsx'
import './TeacherSchedules.css'

// CP121/CP122: teacher schedule upload (proof + record keeping). Teachers upload/see their own; MIS (Super Admin) uploads for a chosen teacher and sees all.
// CP123: Dean and custom roles ('Others') upload/see/download their own schedules only, like Teacher (the server enforces it).
// MIS Staff ('Inventory Staff') can only search, view and download all schedules (no upload form). An upload is a reusable record - no per-reservation re-upload.
// CP162: PDF-only upload with a preview/confirm popup and Undo; rows offer View and Delete (CP163: plus Download on the Super Admin/MIS Staff page only); Super Admin page = search + table (no upload form); 5-row typeable pagination.
function formatSize(bytes) {
    const n = Number(bytes) || 0
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`
}
const PREVIEW_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']
const extOf = name => String(name || '').split('.').pop().toLowerCase()
const canPreview = item => PREVIEW_EXT.includes(extOf(item.file_name))
function readAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
    })
}

export default function TeacherSchedules() {
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null } })()
    const isMis = user?.role === 'MIS'
    const isStaff = user?.role === 'Inventory Staff'
    const canUpload = ['Teacher', 'Dean', 'Others'].includes(user?.role) // CP162: Super Admin's Teacher Schedules page no longer has upload controls
    const viewAll = isMis || isStaff
    const allowed = canUpload || isStaff || isMis
    const [schedules, setSchedules] = useState([])
    const [file, setFile] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [message, setMessage] = useState({ text: '', type: 'success' })
    const [saving, setSaving] = useState(false)
    const [search, setSearch] = useState('')
    const [term, setTerm] = useState('')
    const fileInput = useRef(null)
    const [pending, setPending] = useState(null) // CP162: { url } local preview of the chosen PDF awaiting Confirm
    const [page, setPage] = useState(1)
    const [pageInput, setPageInput] = useState('1')
    const pageSize = 5 // CP187: 5 rows per page (typed page number + Previous / Next already present)
    const [preview, setPreview] = useState(null)
    const { confirm, notify, undoToast } = useClmsDialog()

    async function load(searchTerm = term) {
        setLoading(true); setError('')
        try {
            const list = await api.get('/teacher-schedules', { params: viewAll && searchTerm ? { search: searchTerm } : {} })
            setSchedules(list.data.schedules || [])
            setPage(1); setPageInput('1')
        } catch (err) { setError(err.response?.data?.message || 'Unable to load schedules.') }
        finally { setLoading(false) }
    }
    useEffect(() => {
        if (!allowed) return undefined
        let active = true
        Promise.resolve().then(() => { if (active) load() })
        return () => { active = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    // CP122: search by teacher name (server-side), applied shortly after typing stops.
    useEffect(() => {
        if (!allowed || !viewAll || search.trim() === term) return undefined
        const timer = setTimeout(() => { const next = search.trim(); setTerm(next); load(next) }, 300)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search])

    if (!allowed) return <div className="schedules-denied"><h1>Access Denied</h1><p>Your account role cannot use Teacher Schedules.</p></div>

    // CP162: PDF-only check (name, declared type and the %PDF- signature of the real bytes). Rejections use a popup and clear the chosen file.
    async function chooseFile(event) {
        const chosen = event.target.files?.[0] || null
        setFile(null)
        if (!chosen) return
        let head = ''
        try { head = await chosen.slice(0, 1024).text() } catch { head = '' }
        const typeOk = !chosen.type || chosen.type === 'application/pdf'
        if (!/\.pdf$/i.test(chosen.name) || !typeOk || !head.includes('%PDF-')) {
            if (fileInput.current) fileInput.current.value = ''
            await notify('Only PDF files can be uploaded. Please choose a PDF file.', { title: 'PDF files only' })
            return
        }
        setFile(chosen)
    }

    // CP162: Upload opens a confirmation popup showing the real selected PDF; nothing is sent until Confirm.
    function upload(event) {
        event.preventDefault()
        setMessage({ text: '', type: 'success' })
        if (!file) { setMessage({ text: 'Choose a PDF schedule file to upload.', type: 'error' }); return }
        setPending({ url: URL.createObjectURL(file), name: file.name })
    }
    function cancelPending() { if (pending?.url) URL.revokeObjectURL(pending.url); setPending(null) }
    async function confirmUpload() {
        setSaving(true)
        try {
            const fileBase64 = await readAsBase64(file)
            const result = await api.post('/teacher-schedules', { fileName: file.name, fileType: file.type || 'application/pdf', fileBase64 })
            const newId = result.data?.schedule?.id
            cancelPending(); setFile(null); if (fileInput.current) fileInput.current.value = ''
            await load()
            undoToast('Schedule uploaded successfully. Click Undo to remove it.', async () => {
                const undone = await api.post(`/teacher-schedules/${newId}/undo-upload`)
                await load()
                return undone.data?.message || 'Upload undone.'
            }, { label: 'Undo', title: 'Uploaded' })
        } catch (err) {
            cancelPending()
            setMessage({ text: err.response?.data?.message || 'Unable to upload the schedule.', type: 'error' })
        } finally { setSaving(false) }
    }

    useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview])

    async function view(item) {
        if (!canPreview(item)) { setPreview({ item, unavailable: true }); return }
        setPreview({ item, loading: true })
        try {
            const response = await api.get(`/teacher-schedules/${item.id}/view`, { responseType: 'blob' })
            setPreview({ item, url: URL.createObjectURL(response.data), kind: extOf(item.file_name) === 'pdf' ? 'pdf' : 'image' })
        } catch { setPreview({ item, unavailable: true }) }
    }

    // CP128: delete/cancel a schedule (soft delete -> Recycle Bin). The server decides who may delete; the button only shows when it says can_delete.
    async function remove(item) {
        if (!await confirm(`Delete the schedule file “${item.file_name}”${viewAll && item.teacher_name ? ` of ${item.teacher_name}` : ''}? It will no longer appear in the schedule list.${isMis ? ' It will be moved to the Recycle Bin.' : ' This cannot be undone.'}`, { title: 'Delete schedule', confirmLabel: 'Delete', danger: true })) return
        try {
            await api.delete(`/teacher-schedules/${item.id}`)
            if (preview?.item?.id === item.id) setPreview(null)
            setMessage({ text: isMis ? 'Schedule deleted. It was moved to the Recycle Bin.' : 'Schedule deleted.', type: 'success' })
            await load()
        } catch (err) { setMessage({ text: err.response?.data?.message || 'Unable to delete the schedule.', type: 'error' }) }
    }

    // CP163: Download is offered only on the Super Admin / MIS Staff Teacher Schedules page (viewAll). Dean/Teacher/Others (My Schedule) keep View and Delete only.
    async function download(item) {
        try {
            const response = await api.get(`/teacher-schedules/${item.id}/download`, { responseType: 'blob' })
            const url = URL.createObjectURL(response.data)
            const link = document.createElement('a')
            link.href = url; link.download = item.file_name; document.body.appendChild(link); link.click(); link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch { setMessage({ text: 'Unable to download this schedule.', type: 'error' }) }
    }

    const pageCount = Math.max(1, Math.ceil(schedules.length / pageSize))
    const currentPage = Math.min(page, pageCount)
    const pageRows = schedules.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    // CP187: an empty / invalid entry returns to the current page (same as every other list page); other numbers are clamped to 1..pageCount.
    function goTo(value) { const wanted = String(value).trim() === '' ? NaN : Math.trunc(Number(value)); const n = Number.isFinite(wanted) ? Math.min(pageCount, Math.max(1, wanted)) : currentPage; setPage(n); setPageInput(String(n)) }

    return <section className="schedules-page">
        <h1 className="clms-page-title">{viewAll ? 'Teacher Schedules' : 'My Schedule'}</h1>
        {canUpload && <form className="schedules-card schedules-upload" onSubmit={upload}>
            <h2>Upload schedule</h2>
            <p className="schedules-note">Upload once - the saved schedule is reused, so you do not need to upload it again for each reservation.</p>
            <div className="schedules-fields">
                <label>Schedule file (PDF only)<input ref={fileInput} type="file" accept="application/pdf,.pdf" onChange={chooseFile} /></label>
                <button type="submit" className="schedules-primary" disabled={saving || !file}>Upload</button>
            </div>
            {message.text && <p className={`schedules-message ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p>}
        </form>}
        {!canUpload && message.text && <p className={`schedules-message ${message.type}`} role="status">{message.text}</p>}
        <div className="schedules-card">
            <h2>{viewAll ? 'Uploaded teacher schedules' : 'My uploaded schedules'}</h2>
            {viewAll && <div className="schedules-fields schedules-search"><label>Search<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Teacher name or username" maxLength={100} /></label></div>}
            {loading && <p className="schedules-state">Loading schedules…</p>}
            {!loading && error && <p className="schedules-state error">{error} <button type="button" onClick={() => load()}>Try Again</button></p>}
            {!loading && !error && <div className="schedules-table-wrap"><table className="schedules-table">
                <thead><tr>{viewAll && <th>Teacher</th>}<th>File</th><th>Size</th><th>Uploaded by</th><th>Uploaded</th><th>Actions</th></tr></thead>
                <tbody>{schedules.length === 0 ? <tr><td colSpan={viewAll ? 6 : 5} className="schedules-empty">{viewAll && term ? 'No schedules match that search.' : 'No schedules uploaded yet.'}</td></tr> : pageRows.map(item => <tr key={item.id}>
                    {viewAll && <td>{item.teacher_name || 'Removed user'}{item.teacher_username ? <small> ({item.teacher_username})</small> : null}</td>}
                    <td>{item.file_name}</td><td>{formatSize(item.file_size)}</td><td>{item.uploaded_by_name || 'Removed user'}</td>
                    <td>{item.uploaded_at ? new Date(item.uploaded_at).toLocaleString() : '—'}</td>
                    <td className="schedules-actions"><button type="button" onClick={() => view(item)} aria-label={`View ${item.file_name}`}>View</button> {viewAll && <><button type="button" onClick={() => download(item)} aria-label={`Download ${item.file_name}`}>Download</button> </>}{item.can_delete && <> <button type="button" className="schedules-delete" onClick={() => remove(item)} aria-label={`Delete ${item.file_name}`}>Delete</button></>}</td>
                </tr>)}</tbody>
            </table></div>}
            {!loading && !error && schedules.length > 0 && <div className="schedules-pager" role="navigation" aria-label="Schedule pages">
                <button type="button" onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1}>Previous</button>
                <label>Page <input type="text" inputMode="numeric" aria-label="Page number" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} onBlur={() => goTo(pageInput)} onKeyDown={event => { if (event.key === 'Enter') goTo(pageInput) }} /> of {pageCount}</label>
                <button type="button" onClick={() => goTo(currentPage + 1)} disabled={currentPage >= pageCount}>Next</button>
                
            </div>}
        </div>
        {pending && <div className="schedules-modal" role="dialog" aria-modal="true" aria-label="Confirm upload">
            <div className="schedules-modal-box">
                <div className="schedules-modal-head"><strong>Confirm upload: {pending.name}</strong>
                    <span><button type="button" onClick={cancelPending} disabled={saving}>Cancel</button> <button type="button" className="schedules-primary" onClick={confirmUpload} disabled={saving}>{saving ? 'Uploading…' : 'Confirm Upload'}</button></span></div>
                <div className="schedules-modal-body"><iframe title="Selected PDF preview" src={pending.url} className="schedules-frame" /></div>
            </div>
        </div>}
        {preview && <div className="schedules-modal" role="dialog" aria-modal="true" aria-label="Schedule preview" onClick={event => { if (event.target === event.currentTarget) setPreview(null) }}>
            <div className="schedules-modal-box">
                <div className="schedules-modal-head"><strong>{preview.item.file_name}</strong>
                    <span>{viewAll && <><button type="button" onClick={() => download(preview.item)}>Download</button> </>}<button type="button" onClick={() => setPreview(null)}>Close</button></span></div>
                <div className="schedules-modal-body">
                    {preview.loading && <p className="schedules-state">Loading preview…</p>}
                    {preview.unavailable && <p className="schedules-state">Preview unavailable for this file.</p>}
                    {preview.url && preview.kind === 'pdf' && <iframe title={preview.item.file_name} src={preview.url} className="schedules-frame" />}
                    {preview.url && preview.kind === 'image' && <img src={preview.url} alt={preview.item.file_name} className="schedules-image" />}
                </div>
            </div>
        </div>}
    </section>
}
