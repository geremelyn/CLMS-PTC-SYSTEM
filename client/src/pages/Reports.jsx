import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../api'
import { useNavigate } from 'react-router-dom'
import MISPageShell from '../components/MISPageShell'
import { printHtmlDocument } from '../utils/pdfPrint.js'
import { buildMyReportsPdfHtml } from '../utils/myReportsPdf.js'
import { buildReportsPdfHtml } from '../utils/reportsPdf.js'
import './Reports.css'
import { formatReportValue as formatValue, makeReportViewRows as makeViewRows, displayReportColumn as displayColumn, filterMaintenanceByKind, MAINTENANCE_KINDS } from '../utils/reportFormatting.mjs'

const MIS_REPORTS = [
    ['reservations', 'Reservation Reports'],
    ['inventory', 'Inventory'],
    ['maintenance', 'Maintenance'],
    ['user-accounts', 'User Accounts'],
]
const FACULTY_REPORTS = [['maintenance', 'My Issue Reports']]
const INVENTORY_REPORTS = [
    ['reservations', 'Reservation Reports'],
    ['inventory', 'Inventory'],
    ['maintenance', 'Maintenance'],
]


export default function Reports() {
    const navigate = useNavigate()
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null } })()
    const [issueMenuOpen, setIssueMenuOpen] = useState(false)
    const issueMenuRef = useRef(null)
    useEffect(() => {
        if (!issueMenuOpen) return undefined
        const close = event => { if (event.type === 'keydown' ? event.key === 'Escape' : !issueMenuRef.current?.contains(event.target)) setIssueMenuOpen(false) }
        document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
    }, [issueMenuOpen])
    const isMIS = user?.role === 'MIS'
    const isInventory = user?.role === 'Inventory Staff'
    const isFaculty = user?.role === 'Dean' || user?.role === 'Teacher' || user?.role === 'Others' // each sees ONLY their own reports (server-enforced)
    const isCustomRole = user?.role === 'Others'
    const hideReportTitle = ['MIS', 'Dean', 'Teacher'].includes(user?.role)
    const options = useMemo(() => isMIS ? MIS_REPORTS : isInventory ? INVENTORY_REPORTS : FACULTY_REPORTS, [isMIS, isInventory])
    const [selected, setSelected] = useState(options[0][0])
    const activeSelected = options.some(([key]) => key === selected) ? selected : options[0][0]
    const [data, setData] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [searchTerm, setSearchTerm] = useState('')
    const [maintenanceKind, setMaintenanceKind] = useState('computers')
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page (typed page number + Previous / Next already present)
    // CP167: row selection (keyed by the row's index in the unfiltered report, which maps 1:1 to the raw report rows) and a typeable page box.
    const [selectedRows, setSelectedRows] = useState(() => new Set())
    const [pageInput, setPageInput] = useState('1')

    useEffect(() => { if (!isMIS && !isInventory && !isFaculty) navigate('/') }, [isMIS, isInventory, isFaculty, navigate])
    useEffect(() => {
        let cancelled = false
        async function load() {
            setLoading(true); setError('')
            try {
                const response = await api.get(`/reports/${activeSelected}`)
                if (!cancelled) { setData(response.data.report || []); setCurrentPage(1); setSearchTerm(''); setSelectedRows(new Set()) }
            } catch (err) {
                if (!cancelled) { setData([]); setError(err.response?.data?.message || 'Unable to load this report.') }
            } finally { if (!cancelled) setLoading(false) }
        }
        if ((isMIS || isInventory || isFaculty) && activeSelected) load()
        return () => { cancelled = true }
    }, [activeSelected, isMIS, isInventory, isFaculty])

    const showMaintenanceKind = activeSelected === 'maintenance' && !isFaculty
    const reportData = showMaintenanceKind ? filterMaintenanceByKind(data, maintenanceKind) : data
    const viewRows = makeViewRows(reportData, activeSelected, showMaintenanceKind ? maintenanceKind : (isFaculty && activeSelected === 'maintenance' ? 'combined' : null))
    const columns = viewRows.length ? Object.keys(viewRows[0]) : []
    const search = searchTerm.trim().toLocaleLowerCase()
    const filteredEntries = viewRows.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => !search || Object.values(row).some(value => formatValue(value).toLocaleLowerCase().includes(search)))
    const filteredData = filteredEntries.map(entry => entry.row)
    const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const firstRecord = filteredData.length ? (safePage - 1) * pageSize + 1 : 0
    const lastRecord = Math.min(safePage * pageSize, filteredData.length)
    const pageEntries = filteredEntries.slice((safePage - 1) * pageSize, safePage * pageSize)
    const selectedVisible = filteredEntries.filter(entry => selectedRows.has(entry.rowIndex))
    const selectedCount = selectedVisible.length
    const allSelected = filteredEntries.length > 0 && selectedCount === filteredEntries.length
    const pageAllSelected = pageEntries.length > 0 && pageEntries.every(entry => selectedRows.has(entry.rowIndex))
    useEffect(() => { setPageInput(String(safePage)) }, [safePage])
    function goToPage(value) { const n = parseInt(value, 10); const next = Number.isFinite(n) ? Math.min(totalPages, Math.max(1, n)) : safePage; setCurrentPage(next); setPageInput(String(next)) }
    function toggleRow(rowIndex) { setSelectedRows(prev => { const next = new Set(prev); if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex); return next }) }
    function togglePageRows() { setSelectedRows(prev => { const next = new Set(prev); if (pageAllSelected) pageEntries.forEach(e => next.delete(e.rowIndex)); else pageEntries.forEach(e => next.add(e.rowIndex)); return next }) }
    function toggleSelectAll() { setSelectedRows(allSelected ? new Set() : new Set(filteredEntries.map(e => e.rowIndex))) }
    function resetView() { setCurrentPage(1); setSearchTerm(''); setSelectedRows(new Set()) }
    const baseTitle = options.find(([key]) => key === activeSelected)?.[1] || 'Report'
    const title = showMaintenanceKind ? `${baseTitle} – ${MAINTENANCE_KINDS.find(([key]) => key === maintenanceKind)?.[1]}` : baseTitle

    // CP99: Print PDF uses the shared PTC Letter template (header, logos, Printed by) instead of the old A4 landscape browser-print layout.
    async function printReport() { try { await printHtmlDocument(buildReportsPdfHtml(title, columns, selectedCount ? selectedVisible.map(e => e.row) : filteredData, { search: searchTerm.trim(), logoBase: window.location.origin })) } catch { setError('Unable to prepare the PDF. Please try again.') } }
    // CP85: custom roles save their own reports with the official PTC header (logo, school, address, IICT line).
    async function saveMyReportsPdf() { try { await printHtmlDocument(buildMyReportsPdfHtml(selectedCount ? selectedVisible.map(e => reportData[e.rowIndex]).filter(Boolean) : reportData, { owner: user?.full_name || '', logoBase: window.location.origin })) } catch { setError('Unable to prepare the PDF. Please try again.') } }
    function refreshReport() { setSearchTerm(''); setCurrentPage(1); setLoading(true); setError(''); api.get(`/reports/${activeSelected}`).then(response => setData(response.data.report || [])).catch(err => setError(err.response?.data?.message || 'Unable to reload report.')).finally(() => setLoading(false)) }

    // CP145: the PDF action now sits in the results toolbar (same row as the search box); behaviour of each button is unchanged.
    // CP148: Dean and Teacher also get My Reservations + a Report Issue menu (Computers / Equipment) beside Print PDF. Custom-role accounts keep Save as PDF only.
    const showFacultyActions = user?.role === 'Dean' || user?.role === 'Teacher'
    const facultyActions = showFacultyActions && <>
        <button type="button" onClick={() => navigate('/my-reservations')}>My Reservations</button>
        <div className="report-issue-menu" ref={issueMenuRef}>
            <button type="button" aria-haspopup="menu" aria-expanded={issueMenuOpen} onClick={() => setIssueMenuOpen(open => !open)}>Report Issue <span aria-hidden="true">▾</span></button>
            {issueMenuOpen && <div className="report-issue-menu-list" role="menu">
                <button type="button" role="menuitem" onClick={() => { setIssueMenuOpen(false); navigate('/report-issue?type=computer') }}>Computers</button>
                <button type="button" role="menuitem" onClick={() => { setIssueMenuOpen(false); navigate('/report-issue?type=equipment') }}>Equipment</button>
            </div>}
        </div>
    </>
    const actionButtons = isCustomRole ? <button type="button" onClick={saveMyReportsPdf} disabled={loading || !!error}>Save as PDF</button> : <>{facultyActions}<button type="button" onClick={printReport}>Save as PDF</button></>
    // The top card only holds the card title, the report category tabs and the maintenance selector. Dean/Teacher have none of those visible (the single tab stays in the page, hidden by CSS), so the empty card is hidden.
    const tabsCardEmpty = hideReportTitle && isFaculty
    // CP145: classes for the on-screen table: the two note columns (centred, cancellation note narrower) and the Created At date (kept on one line).
    const noteColumnClass = column => column === 'cancellation_note' ? 'report-col-cancellation-note' : column === 'condition_note' ? 'report-col-condition-note' : column === 'created_at' ? 'report-col-date' : undefined

    return <MISPageShell active="reports">
        <h1 className="clms-page-title no-print">Reports</h1>
        <section className={`report-card report-tabs no-print${tabsCardEmpty ? ' report-tabs-empty' : ''}`}>
            {/* CP92: the card title repeats the page title / active tab; hidden for MIS Head, Dean and Teacher (MIS Staff and custom roles unchanged). */}
            {!hideReportTitle && <div className="report-tabs-head"><h2>{title}</h2></div>}
            <div className={`report-tab-list ${isFaculty ? 'report-tab-list-faculty' : ''}`}>
                {options.map(([key, label]) => <button key={key} type="button" className={activeSelected === key ? 'active' : ''} onClick={() => { setSelected(key); resetView() }}>{label}</button>)}
            </div>
        </section>

        <section className={`report-card report-results ${isInventory || isFaculty ? 'report-results-compact' : ''}`}>
            <div className="report-results-toolbar no-print">
                {showMaintenanceKind && <div className="report-maintenance-kind">
                    <label htmlFor="report-maintenance-kind">Maintenance report for</label>
                    <select id="report-maintenance-kind" value={maintenanceKind} onChange={event => { setMaintenanceKind(event.target.value); resetView() }}>
                        {MAINTENANCE_KINDS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                </div>}
                <input id="report-search" type="search" aria-label="Search reports" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1); setSelectedRows(new Set()) }} placeholder="Search name, ID number, date, status, notes…" />
                <strong className="report-record-count">{filteredData.length} {filteredData.length === 1 ? 'record' : 'records'}{selectedCount ? ` · ${selectedCount} selected` : ''}</strong>
                <button type="button" className="report-select-all" onClick={toggleSelectAll} disabled={loading || !!error || filteredData.length === 0}>{allSelected ? 'Clear Selection' : 'Select All'}</button>
                <div className="report-action-group">{actionButtons}</div>
            </div>
            <div className="report-print-heading"><strong>PATEROS TECHNOLOGICAL COLLEGE</strong><h2>{title}</h2></div>
            {loading && <div className="report-state">Loading report…</div>}
            {!loading && error && <div className="report-state error">{error}<button type="button" onClick={refreshReport}>Try Again</button></div>}
            {!loading && !error && filteredData.length === 0 && <div className="report-state">No records match your search.</div>}
            {!loading && !error && filteredData.length > 0 && <><div className="report-table-wrap report-screen-table"><table className="report-table">
                <thead><tr><th className="report-col-check"><input type="checkbox" aria-label="Select all rows on this page" checked={pageAllSelected} onChange={togglePageRows} /></th>{columns.map(column => <th key={column} className={noteColumnClass(column)}>{displayColumn(column)}</th>)}</tr></thead>
                <tbody>{pageEntries.map(({ row, rowIndex }) => <tr key={`${rowIndex}-${activeSelected}`} className={selectedRows.has(rowIndex) ? 'report-row-selected' : undefined}><td className="report-col-check"><input type="checkbox" aria-label="Select row" checked={selectedRows.has(rowIndex)} onChange={() => toggleRow(rowIndex)} /></td>{columns.map(column => <td key={column} className={noteColumnClass(column)}>{formatValue(row[column])}</td>)}</tr>)}</tbody>
            </table></div>
                <div className="report-table-wrap report-print-all"><table className="report-table"><thead><tr>{columns.map(column => <th key={column}>{displayColumn(column)}</th>)}</tr></thead><tbody>{filteredData.map((row, index) => <tr key={`print-${index}-${activeSelected}`}>{columns.map(column => <td key={column}>{formatValue(row[column])}</td>)}</tr>)}</tbody></table></div></>}
            {!loading && !error && filteredData.length > 0 && <div className="report-pagination no-print" aria-label="Report pagination">
                <span>Showing {firstRecord}–{lastRecord} of {filteredData.length} records</span>
                <div className="report-pagination-controls"><button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safePage <= 1}>Previous</button><span className="report-page-jump">Page <input type="text" inputMode="numeric" aria-label="Page number" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} onBlur={() => goToPage(pageInput)} onKeyDown={event => { if (event.key === 'Enter') goToPage(pageInput) }} /> of {totalPages}</span><button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safePage >= totalPages}>Next</button></div>
            </div>}
        </section>
    </MISPageShell>
}
