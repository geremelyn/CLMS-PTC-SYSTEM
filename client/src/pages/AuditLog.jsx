import { useEffect, useState } from 'react'
import PagePager from '../components/PagePager.jsx'
import api from '../api'
import { useClmsDialog } from '../components/ClmsDialog.jsx'
import { printHtmlDocument } from '../utils/pdfPrint.js'
import { buildAuditLogPdfHtml } from '../utils/auditLogPdf.js'
import { ALL_EVENTS, KNOWN_AUDIT_EVENTS, auditEventTypes, filterAuditLogs } from '../utils/auditEventFilter.mjs'
import MISPageShell from '../components/MISPageShell'
import './AuditLog.css'

function roleLabel(log) {
    if (log.role === 'Teacher' && log.program) return `${log.program}-Teacher`
    if (log.role === 'Inventory Staff') return 'MIS Staff'
    return log.role || '—'
}
export default function AuditLog() {
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null } })()
    const [logs, setLogs] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [searchTerm, setSearchTerm] = useState('')
    const [eventType, setEventType] = useState(ALL_EVENTS)
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page; typed page number + Previous / Next
    const { notify } = useClmsDialog()

    async function loadLogs() {
        // CP120: Refresh restores the default view - search cleared, Event Type back to All Events, first page - and reloads the records.
        setSearchTerm(''); setEventType(ALL_EVENTS); setCurrentPage(1)
        setLoading(true); setError('')
        try { const response = await api.get('/audit-logs'); setLogs(response.data.auditLogs || []); setCurrentPage(1) }
        catch (err) { setError(err.response?.data?.message || 'Unable to load audit logs.') }
        finally { setLoading(false) }
    }
    useEffect(() => {
        let active = true
        if (user?.role === 'MIS') {
            Promise.resolve().then(() => { if (active) loadLogs() })
        } else {
            Promise.resolve().then(() => { if (active) setLoading(false) })
        }
        return () => { active = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    if (user?.role !== 'MIS') return <div className="audit-denied"><h1>Access Denied</h1><p>Only MIS may view the audit trail.</p></div>

    const search = searchTerm.trim().toLowerCase()
    const eventTypes = auditEventTypes(logs, KNOWN_AUDIT_EVENTS)
    const activeEventType = eventTypes.includes(eventType) ? eventType : ALL_EVENTS
    const filteredLogs = filterAuditLogs(logs, { eventType: activeEventType, search, roleLabel })
    const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const firstRecord = filteredLogs.length ? (safePage - 1) * pageSize + 1 : 0
    const lastRecord = Math.min(safePage * pageSize, filteredLogs.length)
    async function refresh() { setSearchTerm(''); setLoading(true); setError(''); try { const response = await api.get('/audit-logs'); setLogs(response.data.auditLogs || []); setCurrentPage(1) } catch (err) { setError(err.response?.data?.message || 'Unable to load audit logs.') } finally { setLoading(false) } }
    const pageLogs = filteredLogs.slice((safePage - 1) * pageSize, safePage * pageSize)
    // CP102: shared PTC Letter PDF of every audit entry matching the current search (Super Admin only, same as the page).
    async function handlePrintPdf() {
        try {
            await printHtmlDocument(buildAuditLogPdfHtml(filteredLogs, { roleLabel, search: searchTerm.trim(), eventType: activeEventType, logoBase: window.location.origin }))
        } catch {
            await notify('Unable to prepare the PDF. Please try again.', { title: 'PDF failed' })
        }
    }
    return <MISPageShell active="audit">
        <h1 className="clms-page-title no-print">Audit Log</h1>
        <section className="audit-card audit-results">
            <div className="audit-toolbar no-print">
                <div><small>AUDIT LOG</small><strong>{filteredLogs.length} records</strong></div>
                <div className="audit-actions"><button type="button" onClick={loadLogs} disabled={loading}>Refresh</button><button type="button" onClick={handlePrintPdf}>Save as PDF</button></div>
            </div>
            <div className="audit-search-row no-print"><label htmlFor="audit-search">Search all audit fields</label><input id="audit-search" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1) }} placeholder="Search ID number, name, role, action, description, date…" /><label htmlFor="audit-event-type">Event Type</label><select id="audit-event-type" className="audit-event-select" value={activeEventType} onChange={event => { setEventType(event.target.value); setCurrentPage(1) }}><option value={ALL_EVENTS}>All Event Types</option>{eventTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></div>
            <div className="audit-print-heading"><span>CLMS · PATEROS TECHNOLOGICAL COLLEGE</span><h2>Audit Log Report</h2></div>
            {loading && <div className="audit-state">Loading audit trail…</div>}
            {!loading && error && <div className="audit-state error">{error}<button type="button" onClick={loadLogs}>Try Again</button></div>}
            {!loading && !error && <><div className="audit-table-wrap audit-screen-table"><table className="audit-table">
                <thead><tr><th>Action</th><th>Description</th><th>Date &amp; Time</th><th>Recorded By</th><th>ID Number</th><th>Role</th></tr></thead>
                <tbody>{filteredLogs.length === 0 ? <tr><td colSpan="6" className="audit-empty">No audit activities match your search.</td></tr> : pageLogs.map((log) => <tr key={log.id}>
                    <td><span className="audit-action">{log.action || '—'}</span></td><td>{log.description || '—'}</td><td>{log.created_at ? new Date(log.created_at).toLocaleString() : '—'}</td><td>{log.full_name || 'System'}</td><td>{log.username || '—'}</td><td>{roleLabel(log)}</td>
                </tr>)}</tbody>
            </table></div>
                <div className="audit-table-wrap audit-print-all"><table className="audit-table"><thead><tr><th>Action</th><th>Description</th><th>Date &amp; Time</th><th>Recorded By</th><th>ID Number</th><th>Role</th></tr></thead><tbody>{filteredLogs.map(log => <tr key={`print-${log.id}`}><td>{log.action || '—'}</td><td>{log.description || '—'}</td><td>{log.created_at ? new Date(log.created_at).toLocaleString() : '—'}</td><td>{log.full_name || 'System'}</td><td>{log.username || '—'}</td><td>{roleLabel(log)}</td></tr>)}</tbody></table></div></>}
            {!loading && !error && filteredLogs.length > 0 && <PagePager className="audit-pagination" ariaLabel="Audit log pagination" summary={`Showing ${firstRecord}–${lastRecord} of ${filteredLogs.length} records`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />}
        </section>
    </MISPageShell>
}
