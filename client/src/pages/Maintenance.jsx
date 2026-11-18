import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx';
import { useEffect, useState } from 'react'
import OptionSelect from '../components/OptionSelect.jsx'
import { useNavigate } from 'react-router-dom'
import api, { logoutSession } from '../api'
import { printHtmlDocument } from '../utils/pdfPrint.js'
import { buildMaintenanceHistoryPdfHtml } from '../utils/maintenanceHistoryPdf.js'
import './InventoryDashboard.css'
import './Maintenance.css'

const API = ''

function getUser() {
    try {
        return JSON.parse(localStorage.getItem('user')) || {}
    } catch {
        return {}
    }
}

function formatStatus(status) {
    return String(status || '')
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value) {
    if (!value) return '-'

    const date = new Date(value)
    return Number.isNaN(date.getTime())
        ? '-'
        : date.toLocaleString()
}

function statusClass(status) {
    return String(status || '').toLowerCase().replaceAll(' ', '-')
}

function Maintenance({ historyOnlyRoute = false }) {
    const { confirm, prompt, undoToast, notify, askNewOption, feedback } = useClmsDialog();
    const [selectedIds, setSelectedIds] = useState([])
    const [isDeleting, setIsDeleting] = useState(false)
    const navigate = useNavigate()
    const user = getUser()
    const historyOnly = historyOnlyRoute || new URLSearchParams(window.location.search).get('view') === 'history'

    const [maintenance, setMaintenance] = useState([])
    const [computers, setComputers] = useState([])
    const [equipment, setEquipment] = useState([])
    const [editingMaintenance, setEditingMaintenance] = useState(null)
    const [maintenanceStatus, setMaintenanceStatus] = useState('')
    const [statusOther, setStatusOther] = useState('')
    const [maintenanceNote, setMaintenanceNote] = useState('')
    const [finalCondition, setFinalCondition] = useState('')
    // CP112: custom final conditions live in the existing lookup_options lists (computers -> computer_condition, equipment -> equipment_status).
    const [customConditions, setCustomConditions] = useState({ computer_condition: [], equipment_status: [] })
    const [searchTerm, setSearchTerm] = useState('')
    const [activePage, setActivePage] = useState(1)
    const [historyPage, setHistoryPage] = useState(1)
    const pageSize = 5 // CP187: 5 rows per page (typed page number + Previous / Next already present)
    const [message, setMessage] = useState('')
    const [messageType, setMessageType] = useState('success')
    useCenteredFeedback(message, messageType, () => setMessage(''))
    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        // This effect intentionally loads initial page data on mount.
        loadPageData()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / selected filter changes
    }, [])

    useEffect(() => {
        if (historyOnlyRoute || new URLSearchParams(window.location.search).get('view') === 'history') {
            const timer = setTimeout(() => document.getElementById('maintenance-history-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
            return () => clearTimeout(timer)
        }
    }, [historyOnlyRoute])

    useEffect(() => {
        if (!message) return undefined

        const timer = setTimeout(() => {
            setMessage('')
        }, 4500)

        return () => clearTimeout(timer)
    }, [message])

    async function loadPageData() {
        setIsLoading(true)
        setLoadError('')
        try {
            const failures = (await Promise.all([getMaintenance(), getComputers(), getEquipment()])).filter(Boolean)
            if (failures.length) setLoadError(failures.join(' '))
        } finally {
            setIsLoading(false)
        }
    }

    async function getMaintenance() {
        try {
            const response = await api.get(`${API}/maintenance`)
            setMaintenance(response.data.maintenance || [])
            return null
        } catch (error) {
            return error.response?.data?.message || 'Unable to load maintenance records.'
        }
    }

    async function getComputers() {
        try {
            const response = await api.get(`${API}/computers`)
            setComputers(response.data.computers || [])
            return null
        } catch (error) {
            console.error('Unable to load computers:', error.response?.data?.message || error.message)
            return error.response?.data?.message || 'Unable to load computer details for maintenance records.'
        }
    }

    async function getEquipment() {
        try {
            const response = await api.get(`${API}/equipment`)
            setEquipment(response.data.equipment || [])
            return null
        } catch (error) {
            console.error('Unable to load equipment:', error.response?.data?.message || error.message)
            return error.response?.data?.message || 'Unable to load equipment details for maintenance records.'
        }
    }

    function showMessage(text, type = 'success') {
        setMessage(text)
        setMessageType(type)
    }

    function getAvailableStatuses(currentStatus) {
        if (currentStatus === 'PENDING') {
            return ['PENDING', 'IN PROGRESS', 'OTHERS']
        }

        if (currentStatus === 'IN PROGRESS') {
            return ['IN PROGRESS', 'COMPLETED', 'OTHERS']
        }

        if (currentStatus === 'COMPLETED') {
            return ['COMPLETED']
        }

        return []
    }

    function getAssetDetails(record) {
        const isComputer = Boolean(record.computer_id)
        const source = isComputer
            ? computers.find(
                (computer) => Number(computer.id) === Number(record.computer_id)
            )
            : equipment.find(
                (item) => Number(item.id) === Number(record.equipment_id)
            )

        return {
            tag: isComputer
                ? record.computer_asset_tag || 'Removed computer'
                : record.equipment_asset_tag || 'Removed equipment',
            type: isComputer
                ? 'Computer'
                : record.equipment_type || 'Equipment',
            name: source?.computer_name || source?.name || ''
        }
    }

    const DEFAULT_CONDITIONS = [['WORKING', 'Working']]   // CP137: completion offers Working + Others (saved custom conditions are listed too)
    const SERVER_CONDITIONS = ['WORKING', 'NOT WORKING', 'UNDER REPAIR', 'DAMAGED', 'MISSING', 'RETIRED']
    const conditionCategory = editingMaintenance?.computer_id ? 'computer_condition' : 'equipment_status'
    async function loadCustomConditions() {
        const entries = await Promise.all(['computer_condition', 'equipment_status'].map(async category => {
            try { const response = await api.get('/options', { params: { category } }); return [category, response.data.options || []] }
            catch (error) { console.error(`Unable to load ${category} options:`, error.response?.data?.message || error.message); return [category, []] }
        }))
        setCustomConditions(Object.fromEntries(entries))
    }
    // Defaults first (never deletable), then saved custom conditions (the only ones with a delete symbol).
    function conditionEntries() {
        const custom = (customConditions[conditionCategory] || []).filter(option => !SERVER_CONDITIONS.includes(String(option.value).toUpperCase()))
        return [...DEFAULT_CONDITIONS.map(([value, label]) => ({ value, label, custom: false })), ...custom.map(option => ({ value: option.value, label: option.value, custom: true, id: option.id }))]
    }
    // "Others": popup to type the condition -> Cancel/Confirm -> saved permanently -> shown in the dropdown and selected.
    async function chooseOtherCondition() {
        const existing = [...SERVER_CONDITIONS, ...(customConditions[conditionCategory] || []).map(option => option.value)]
        const answer = await askNewOption('asset condition', existing)
        if (!answer) return
        if (answer.existing) { setFinalCondition(answer.value); return }
        if (answer.value.length > 50) { showMessage('A custom asset condition must be 50 characters or fewer. Nothing was saved.', 'error'); return }
        try {
            const response = await api.post('/options', { category: conditionCategory, value: answer.value })
            setCustomConditions(current => ({ ...current, [conditionCategory]: [...(current[conditionCategory] || []), response.data.option].sort((a, b) => a.value.localeCompare(b.value)) }))
            setFinalCondition(answer.value)
            showMessage(`“${answer.value}” saved to the asset condition dropdown.`)
        } catch (error) { showMessage(error.response?.data?.message || 'Unable to save the condition.', 'error') }
    }
    async function deleteCustomCondition(option) {
        if (!await confirm(`Delete the custom asset condition “${option.value}” from the dropdown? Existing records keep their value.`, { title: 'Delete custom option', confirmLabel: 'Delete', danger: true })) return
        try {
            const response = await api.delete(`/options/${option.id}`)
            setCustomConditions(current => ({ ...current, [conditionCategory]: (current[conditionCategory] || []).filter(item => item.id !== option.id) }))
            if (String(finalCondition) === String(option.value)) setFinalCondition('')
            feedback(response.data.message || 'Custom option deleted.')
        } catch (error) { showMessage(error.response?.data?.message || 'Unable to delete the option. Nothing was changed.', 'error') }
    }

    function openUpdateModal(record) {
        setEditingMaintenance(record)
        setMaintenanceStatus(record.status_other ? 'OTHERS' : record.status)
        setStatusOther(record.status_other || '')
        setMaintenanceNote(record.maintenance_note || '')
        setFinalCondition('')
        loadCustomConditions()
    }

    function closeUpdateModal(force = false) {
        if (isSaving && !force) return

        setEditingMaintenance(null)
        setMaintenanceStatus('')
        setStatusOther('')
        setMaintenanceNote('')
        setFinalCondition('')
    }

    async function handleUpdateMaintenance(event) {
        event.preventDefault()

        if (maintenanceStatus === 'COMPLETED' && !finalCondition) {
            showMessage('Please select the final asset condition', 'error')
            return
        }
        if (maintenanceStatus === 'OTHERS' && !statusOther.trim()) {
            showMessage('Enter the custom maintenance status for Others', 'error')
            return
        }
        if (!await confirm(maintenanceStatus === 'OTHERS' ? `Save the custom status "${statusOther.trim()}"?` : 'Save these maintenance changes?')) return

        setIsSaving(true)

        try {
            const response = await api.put(
                `${API}/maintenance/${editingMaintenance.id}`,
                {
                    status: maintenanceStatus,
                    status_other: maintenanceStatus === 'OTHERS' ? statusOther.trim() : null,
                    maintenance_note: maintenanceNote.trim(),
                    final_condition:
                        maintenanceStatus === 'COMPLETED'
                            ? finalCondition
                            : null
                }
            )

            showMessage('Maintenance updated successfully')
            closeUpdateModal(true)
            await loadPageData()
            // Genuine undo: restores the previous maintenance row and the asset condition (server checks it is unchanged and recent).
            const undoActionId = response.data.undoActionId
            if (undoActionId) undoToast('Successfully updated.', async () => {
                const undone = await api.post(`${API}/maintenance/undo/${undoActionId}`)
                await loadPageData()
                return undone.data.message || 'Maintenance update undone.'
            })
        } catch (error) {
            showMessage(
                error.response?.data?.message ||
                'Unable to update maintenance',
                'error'
            )
        } finally {
            setIsSaving(false)
        }
    }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    const activeMaintenance = maintenance.filter(
        (record) => !['CLOSED', 'COMPLETED'].includes(record.status)
    )

    const maintenanceHistory = maintenance.filter(
        (record) => ['CLOSED', 'COMPLETED'].includes(record.status)
    )

    const search = searchTerm.trim().toLowerCase()
    function filterRecords(records) {
        return records.filter((record) => {
            const asset = getAssetDetails(record)
            const searchableText = [asset.tag, asset.type, asset.name, record.reported_by_name, record.reported_by_username, record.reported_by_program, record.reported_by_role, record.issue_description, record.status, record.maintenance_note, record.status_other, formatStatus(record.status), record.reported_by_role === 'Inventory Staff' ? 'MIS Staff' : '', record.date_reported, formatDate(record.date_reported), record.date_resolved, formatDate(record.date_resolved)].filter(Boolean).join(' ').toLowerCase()
            return !search || searchableText.includes(search)
        })
    }

    const visibleActiveMaintenance = filterRecords(activeMaintenance)
    const visibleMaintenanceHistory = filterRecords(maintenanceHistory)

    // CP101: shared PTC Letter PDF of every history record matching the current search (same access as before; button is now "Save as PDF" beside Delete All).
    async function handlePrintHistoryPdf() {
        try {
            await printHtmlDocument(buildMaintenanceHistoryPdfHtml(visibleMaintenanceHistory, { getAsset: getAssetDetails, search: searchTerm.trim(), logoBase: window.location.origin }))
        } catch {
            await notify('Unable to prepare the PDF. Please try again.', { title: 'PDF failed' })
        }
    }

    const canUpdateMaintenance = ['MIS', 'Inventory Staff'].includes(user?.role)
    // Same roles that can already open and update Maintenance may delete; deleted records go to the Recycle Bin (restorable).
    const canDeleteMaintenance = canUpdateMaintenance
    const toggleMaintenanceRow = id => setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])

    // `all` = Delete All for the current view (search applied). IN PROGRESS records are never sent: the asset is under repair because of them.
    async function deleteMaintenanceRecords(viewRecords, all) {
        if (isDeleting) return
        const pool = all ? viewRecords : viewRecords.filter(record => selectedIds.includes(record.id))
        const deletable = pool.filter(record => String(record.status || '').toUpperCase() !== 'IN PROGRESS')
        const inProgress = pool.length - deletable.length
        const ids = deletable.map(record => Number(record.id)).filter(id => Number.isSafeInteger(id) && id > 0)
        if (!ids.length) { setMessage(inProgress ? `Nothing to delete: ${inProgress} In Progress record${inProgress === 1 ? '' : 's'} cannot be deleted. Complete or close ${inProgress === 1 ? 'it' : 'them'} first.` : 'There are no maintenance records to delete.'); setMessageType('error'); return }
        if (ids.length > 5000) { setMessage('Too many records for one deletion (limit 5,000). Narrow the list with the search box and try again.'); setMessageType('error'); return }
        const scope = all ? `all ${ids.length} maintenance record${ids.length === 1 ? '' : 's'} in this list` : `${ids.length} selected maintenance record${ids.length === 1 ? '' : 's'}`
        const note = inProgress ? ` ${inProgress} In Progress record${inProgress === 1 ? ' is' : 's are'} not included and will stay.` : ''
        if (!await confirm(`Delete ${scope}? They will be moved to the Recycle Bin and can be restored. The computers and equipment they refer to are not changed.${note}`, { title: 'Delete maintenance records', confirmLabel: 'Delete', danger: true })) return
        setIsDeleting(true)
        try {
            const { data } = await api.post(`${API}/maintenance/bulk-delete`, { ids })
            setSelectedIds([])
            await loadPageData()
            const undoId = data.undoActionId
            undoToast(data.message || 'Maintenance records deleted.', async () => {
                const restored = await api.post(`${API}/maintenance/undo-bulk-delete/${undoId}`)
                await loadPageData()
                return restored.data.message || 'Maintenance records restored.'
            }, { label: 'Restore', title: 'Deleted' })
        } catch (error) {
            setMessage(error.response?.data?.message || 'Unable to delete the maintenance records. Nothing was deleted.'); setMessageType('error')
        } finally { setIsDeleting(false) }
    }
    // CP113: the selection / delete buttons live in the page toolbar (one row with the search and the summary box).
    // CP169: on the History page the Save as PDF button sits in this bar directly to the left of Delete All.
    function renderBulkControls(records, withPdf = false) {
        const selectedInView = records.filter(record => selectedIds.includes(record.id))
        const allInViewSelected = records.length > 0 && selectedInView.length === records.length
        return (
            (canDeleteMaintenance || withPdf) ? <div className={`maintenance-bulk-bar no-print${withPdf ? ' has-pdf' : ''}`}>
                    {/* CP188: one toggle like the Reservations reference - Select All, then Clear Selection once every listed record is selected */}
                    {canDeleteMaintenance && <button type="button" className="maintenance-update-button" onClick={() => setSelectedIds(allInViewSelected ? [] : current => [...new Set([...current, ...records.map(record => record.id)])])} disabled={!records.length || isDeleting}>{allInViewSelected ? 'Clear Selection' : 'Select All'}</button>}
                    {canDeleteMaintenance && selectedInView.length > 0 && <button type="button" className="clms-delete-all" onClick={() => deleteMaintenanceRecords(records, false)} disabled={isDeleting}>Delete ({selectedInView.length})</button>}
                    {withPdf && <button type="button" className="maintenance-update-button maintenance-save-pdf" onClick={handlePrintHistoryPdf}>Save as PDF</button>}
                    {canDeleteMaintenance && <button type="button" className="clms-delete-all" onClick={() => deleteMaintenanceRecords(records, true)} disabled={isDeleting || !records.length}>Delete All</button>}
                </div> : null
        )
    }

    function renderMaintenanceTable(records, showActionsRequested) {
        const showActions = showActionsRequested && canUpdateMaintenance
        if (isLoading) {
            return (
                <div className="maintenance-empty">
                    Loading maintenance records...
                </div>
            )
        }

        if (records.length === 0) {
            return (
                <div className="maintenance-empty">
                    No records match this view.
                </div>
            )
        }

        const [currentPage, setCurrentPage] = showActions ? [activePage, setActivePage] : [historyPage, setHistoryPage]
        const totalPages = Math.max(1, Math.ceil(records.length / pageSize))
        const safePage = Math.min(currentPage, totalPages)
        const pageRecords = records.slice((safePage - 1) * pageSize, safePage * pageSize)
        const selectedInView = records.filter(record => selectedIds.includes(record.id))
        const allInViewSelected = records.length > 0 && selectedInView.length === records.length
        return (
            <div className="maintenance-table-wrap">
                <table className="maintenance-table">
                    <thead><tr>{canDeleteMaintenance && <th className="no-print maintenance-select-cell"><input type="checkbox" aria-label="Select all records in this list" checked={allInViewSelected} onChange={() => setSelectedIds(allInViewSelected ? current => current.filter(id => !records.some(record => record.id === id)) : current => [...new Set([...current, ...records.map(record => record.id)])])} /></th>}<th>Asset</th><th>Reported By (ID Number, Name, Program, Role)</th><th>Issue</th><th>Status</th><th>Reported / Resolved Date &amp; Time</th>{showActions && <th>Actions</th>}</tr></thead>
                    <tbody>
                        {pageRecords.map((record) => {
                            const asset = getAssetDetails(record)

                            return (
                                <tr key={record.id}>
                                    {canDeleteMaintenance && <td className="no-print maintenance-select-cell"><input type="checkbox" aria-label={`Select maintenance record ${record.id}`} checked={selectedIds.includes(record.id)} onChange={() => toggleMaintenanceRow(record.id)} /></td>}
                                    <td>
                                        <strong>{asset.tag}</strong>
                                        <small>
                                            {asset.type}
                                            {asset.name && ` - ${asset.name}`}
                                        </small>
                                    </td>
                                    <td>
                                        <strong>{record.reported_by_name || 'Unknown user'}</strong>
                                        <small>ID Number: {record.reported_by_username || '—'}</small>
                                        <small>{record.reported_by_program || '—'} · {record.reported_by_role === 'Inventory Staff' ? 'MIS Staff' : record.reported_by_role || '—'}</small>
                                    </td>
                                    <td className="maintenance-issue">
                                        {record.issue_description ||
                                            'No issue description'}
                                    </td>
                                    <td>
                                        <span
                                            className={`maintenance-status ${statusClass(
                                                record.status
                                            )}`}
                                        >
                                            {record.status_other ? record.status_other : formatStatus(record.status)}
                                        </span>
                                        {record.maintenance_note && (
                                            <small className="maintenance-note-preview">
                                                {record.maintenance_note}
                                            </small>
                                        )}
                                    </td>
                                    <td>
                                        <strong>Reported</strong>
                                        <small>
                                            {formatDate(record.date_reported)}
                                        </small>
                                        <strong className="maintenance-resolved-label">
                                            Resolved
                                        </strong>
                                        <small>
                                            {formatDate(record.date_resolved)}
                                        </small>
                                    </td>
                                    {showActions && (
                                        <td>
                                            <button
                                                type="button"
                                                className="maintenance-update-button"
                                                onClick={() =>
                                                    openUpdateModal(record)
                                                }
                                            >
                                                Update
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
                <div className="maintenance-pagination no-print"><span>Showing {records.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, records.length)} of {records.length} records</span><button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safePage <= 1}>Previous</button><span className="maintenance-page-jump">Page <input key={`${safePage}-${totalPages}`} type="text" inputMode="numeric" aria-label="Page number" defaultValue={safePage} onChange={event => { event.target.value = event.target.value.replace(/\D/g, '') }} onBlur={event => { const n = parseInt(event.target.value, 10); const next = Number.isFinite(n) ? Math.min(totalPages, Math.max(1, n)) : safePage; setCurrentPage(next); event.target.value = String(next) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /> of {totalPages}</span><button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safePage >= totalPages}>Next</button></div>
            </div>
        )
    }

    return (
        <div className="maintenance-page">
            <div className="maintenance-overlay" />

            <header className="maintenance-header">
                <button
                    className="maintenance-brand"
                    type="button"
                    onClick={() => navigate('/inventory-dashboard')}
                >
                    <span className="maintenance-brand-logo">
                        <img src="/clms-logo.png" alt="CLMS Logo" />
                    </span>
                    <span>
                        <strong>CLMS</strong>
                        <small>Pateros Technological College</small>
                    </span>
                </button>

                <div className="maintenance-user">
                    <span className="maintenance-avatar">
                        {user.full_name?.charAt(0)?.toUpperCase() || 'I'}
                    </span>
                    <span className="maintenance-user-info">
                        <strong>{user.full_name || 'MIS Staff'}</strong>
                        <small>MIS Staff</small>
                    </span>
                </div>
            </header>

            <div className="maintenance-layout">
                <aside className="maintenance-sidebar">
                    <div className="maintenance-sidebar-title">MAIN MENU</div>

                    <button
                        type="button"
                        className="maintenance-nav-button"
                        onClick={() => navigate('/inventory-dashboard')}
                    >
                        Dashboard
                    </button>
                    <button
                        type="button"
                        className="maintenance-nav-button"
                        onClick={() => navigate('/equipment')}
                    >
                        Equipment
                    </button>
                    <button
                        type="button"
                        className={`maintenance-nav-button ${!historyOnly ? 'active' : ''}`}
                        onClick={() => navigate('/maintenance')}
                    >
                        Maintenance
                    </button>
                    <button
                        type="button"
                        className={`maintenance-nav-button ${historyOnly ? 'active' : ''}`}
                        onClick={() => navigate('/maintenance-history')}
                    >
                        Maintenance History
                    </button>
                    <button type="button" className="maintenance-nav-button" onClick={() => navigate('/reports')}>Reports</button>
                    <button type="button" className="maintenance-nav-button" onClick={() => navigate('/change-password')}>Change Password</button>

                    <div className="maintenance-sidebar-divider" />

                    <button
                        type="button"
                        className="maintenance-nav-button logout"
                        onClick={handleLogout}
                    >
                        Logout
                    </button>
                </aside>

                <main className="maintenance-main">
                    <section className="maintenance-heading">
                        <div>
                            <h1>{historyOnly ? 'Maintenance History' : 'Maintenance'}</h1>
                        </div>

                    </section>


                    {loadError && <div className="maintenance-alert error" role="alert">
                        <span>{loadError} Some table values may be incomplete until the data is refreshed.</span>{' '}
                        <button type="button" className="maintenance-update-button" onClick={loadPageData} disabled={isLoading}>{isLoading ? 'Retrying…' : 'Retry loading'}</button>
                    </div>}

                    <section className="maintenance-toolbar no-print">
                        <label className="maintenance-search">
                            <span> ⌕ </span>
                            <input
                                value={searchTerm}
                                onChange={(event) => {
                                    setSearchTerm(event.target.value);
                                    setSelectedIds([]);
                                    setActivePage(1);
                                    setHistoryPage(1);
                                }}
                                placeholder="Search maintenance"
                                aria-label="Search maintenance"
                            />
                        </label>
                        {renderBulkControls(historyOnly ? visibleMaintenanceHistory : visibleActiveMaintenance, historyOnly)}
                    </section>

                    {!historyOnly && <section className="maintenance-panel">
                        {renderMaintenanceTable(
                            visibleActiveMaintenance,
                            true
                        )}
                    </section>}

                    {historyOnly && <section className="maintenance-panel" id="maintenance-history-section">
                        {renderMaintenanceTable(visibleMaintenanceHistory, false)}
                    </section>}
                </main>
            </div>

            {editingMaintenance && (
                <div
                    className="maintenance-modal-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeUpdateModal()
                        }
                    }}
                >
                    <section
                        className="maintenance-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="maintenance-modal-title"
                    >
                        <div className="maintenance-modal-header">
                            <div>
                                <p className="maintenance-eyebrow">
                                    WORK ORDER UPDATE
                                </p>
                                <h2 id="maintenance-modal-title">
                                    Update maintenance
                                </h2>
                                <p>
                                    {getAssetDetails(editingMaintenance).tag}{' '}
                                    - {getAssetDetails(editingMaintenance).type}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="maintenance-close"
                                onClick={() => closeUpdateModal()}
                                aria-label="Close"
                            >
                                ✖
                            </button>
                        </div>

                        <form onSubmit={handleUpdateMaintenance}>
                            <label>
                                Status
                                <select
                                    value={maintenanceStatus}
                                    onChange={async (event) => {
                                        const nextStatus = event.target.value
                                        if (nextStatus === 'OTHERS') {
                                            // Others opens a popup for the custom value; cancelling keeps the previous status.
                                            const custom = await prompt('Enter the custom maintenance status:', { title: 'Others', placeholder: 'e.g. Waiting for parts', confirmLabel: 'Use this status' })
                                            if (!custom?.trim()) return
                                            setStatusOther(custom.trim().slice(0, 100))
                                        }
                                        setMaintenanceStatus(nextStatus)

                                        if (nextStatus !== 'COMPLETED') {
                                            setFinalCondition('')
                                        }
                                    }}
                                >
                                    {getAvailableStatuses(
                                        editingMaintenance.status
                                    ).map((statusOption) => (
                                        <option
                                            key={statusOption}
                                            value={statusOption}
                                        >
                                            {statusOption === 'OTHERS' ? 'Others' : formatStatus(statusOption)}
                                        </option>
                                    ))}
                                </select>
                                {maintenanceStatus === 'OTHERS' && <small className="maintenance-others-value">Custom status: <strong>{statusOther}</strong> <button type="button" className="maintenance-update-button" onClick={async () => { const custom = await prompt('Enter the custom maintenance status:', { title: 'Others', confirmLabel: 'Use this status' }); if (custom?.trim()) setStatusOther(custom.trim().slice(0, 100)) }}>Change</button></small>}
                            </label>

                            {maintenanceStatus === 'COMPLETED' && (
                                <label>
                                    Final asset condition
                                    <OptionSelect
                                        required
                                        ariaLabel="Final asset condition"
                                        placeholder="Select final condition"
                                        value={finalCondition}
                                        options={conditionEntries()}
                                        onChange={value => setFinalCondition(value)}
                                        onOthers={chooseOtherCondition}
                                        onDeleteCustom={deleteCustomCondition}
                                    />
                                </label>
                            )}

                            <label>
                                Maintenance note
                                <textarea
                                    rows="5"
                                    value={maintenanceNote}
                                    onChange={(event) =>
                                        setMaintenanceNote(event.target.value)
                                    }
                                    placeholder="Add the latest work performed or next action"
                                />
                            </label>

                            <div className="maintenance-modal-actions">
                                <button
                                    type="button"
                                    className="maintenance-secondary-button"
                                    onClick={() => closeUpdateModal()}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="maintenance-primary-button"
                                    disabled={isSaving}
                                >
                                    {isSaving ? 'Saving...' : 'Save update'}
                                </button>
                            </div>
                        </form>
                    </section>
                </div>
            )}
        </div>
    )
}

export default Maintenance

