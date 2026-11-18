import { deletedMessage } from '../utils/deleteInfo.js'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx'
import OptionSelect from '../components/OptionSelect.jsx';
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MISPageShell from '../components/MISPageShell'
import api, { logoutSession } from '../api'
import './InventoryDashboard.css'
import './Equipment.css'
import FileActionsMenu from '../components/FileActionsMenu.jsx'
import { buildEquipmentPdfHtml, canSaveEquipmentPdf } from '../utils/equipmentPdf.js'
import { printHtmlDocument } from '../utils/pdfPrint.js'

const API = ''
const TYPES = [
    ['MOUSE', 'Mouse'],
    ['KEYBOARD', 'Keyboard'],
    ['HEADSET', 'Headset'],
    ['PRINTER', 'Printer'],
    ['SCANNER', 'Scanner'],
    ['WEBCAM', 'Webcam'],
    ['SPEAKER', 'Speaker'],
    ['OTHER', 'Other']
]
// CP164: two separate fields. Condition (stored in `status`; drives Maintenance) = Working / Not Working / Others.
// Status (stored in `equipment_state`) = Active / Inactive / Others.
const STATUSES = [
    ['WORKING', 'Working'],
    ['NOT WORKING', 'Not Working']
]
const STATES = [
    ['ACTIVE', 'Active'],
    ['INACTIVE', 'Inactive']
]
const PAGE_SIZE = 5
const norm = value => String(value ?? '').trim().toUpperCase()
// CP136: statuses kept from earlier versions (existing records) keep their own look; any other (custom) status is shown in red.
const LEGACY_STATUS_CLASSES = ['working', 'active', 'inactive', 'under-repair', 'damaged', 'missing', 'retired']

function userFromStorage() {
    try {
        return JSON.parse(localStorage.getItem('user')) || {}
    } catch {
        return {}
    }
}
function pretty(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
}
// CP116: these statuses need no condition note (same rule as the server's equipmentStatus.js)
const NO_NOTE_STATUSES = ['WORKING', 'ACTIVE', 'INACTIVE']
const needsNote = (value) => !NO_NOTE_STATUSES.includes(String(value || '').trim().toUpperCase())
function statusClass(value) {
    const cls = String(value || '').toLowerCase().replaceAll(' ', '-')
    return LEGACY_STATUS_CLASSES.includes(cls) ? cls : 'not-working'
}

function Equipment() {
    const { confirm, prompt, undoToast, notify: noticeDialog, askNewOption, feedback } = useClmsDialog();
    const navigate = useNavigate()
    const user = userFromStorage()
    const isMIS = user.role === 'MIS'
    const canManageEquipment = isMIS || user.role === 'Inventory Staff'
    const [equipment, setEquipment] = useState([])
    const [labs, setLabs] = useState([])
    const [computers, setComputers] = useState([])
    const [lookupOptions, setLookupOptions] = useState({ equipment_type: [], equipment_status: [], equipment_state: [] })
    const [loading, setLoading] = useState(true)
    const [modalOpen, setModalOpen] = useState(false)
    const [editing, setEditing] = useState(null)
    const [searchTerm, setSearchTerm] = useState('')
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = PAGE_SIZE // CP164: 5 rows per page; the page is chosen with Previous / Next or by typing a page number
    const [pageInput, setPageInput] = useState('1')
    const [alert, setAlert] = useState({ text: '', type: 'success' })
    useCenteredFeedback(alert.text, alert.type, () => setAlert({ text: '', type: 'success' }))
    const [saving, setSaving] = useState(false)
    const busyRef = useRef(false) // synchronous one-run-only guard: repeated clicks/Enter can never save twice
    const [type, setType] = useState('')
    const [labId, setLabId] = useState('')
    const [computerId, setComputerId] = useState('')
    const [assetTag, setAssetTag] = useState('')
    const [serialNumber, setSerialNumber] = useState('')
    const [brand, setBrand] = useState('')
    const [model, setModel] = useState('')
    const [status, setStatus] = useState('WORKING')
    const [equipmentState, setEquipmentState] = useState('ACTIVE')
    const [conditionNote, setConditionNote] = useState('')
    const [selectedEquipmentIds, setSelectedEquipmentIds] = useState([])

    useEffect(() => {
        loadAll()
        loadLookupOptions()
        const refresh = () => {
            if (document.visibilityState === 'visible') {
                loadEquipment()
                loadComputers()
                loadLabs()
            }
        }
        const timer = window.setInterval(refresh, 5000)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            window.clearInterval(timer)
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; refresh uses current API endpoints
    }, [])
    useEffect(() => {
        if (!alert.text) return undefined

        const timer = setTimeout(
            () => setAlert({ text: '', type: 'success' }),
            4500
        )

        return () => clearTimeout(timer)
    }, [alert.text])

    async function loadLookupOptions() {
        const categories = ['equipment_type', 'equipment_status', 'equipment_state'];
        const entries = await Promise.all(categories.map(async category => {
            try { const { data } = await api.get(`${API}/options`, { params: { category } }); return [category, data.options || []]; }
            catch (error) { console.error(`Unable to load ${category} options:`, error.response?.data?.message || error.message); return [category, []]; }
        }));
        setLookupOptions(Object.fromEntries(entries));
    }
    // "Others": popup to type a value -> Cancel/Confirm -> saved permanently -> shown in the dropdown.
    async function chooseOtherLookup(category, label, existingValues, setter) {
        if (busyRef.current) return;
        busyRef.current = true;
        try { await chooseOtherLookupConfirmed(category, label, existingValues, setter) } finally { busyRef.current = false }
    }
    async function chooseOtherLookupConfirmed(category, label, existingValues, setter) {
        const answer = await askNewOption(label, existingValues);
        if (!answer) return; // cancelled: nothing saved, selection unchanged
        if (answer.existing) { setter(answer.value); return; }
        try {
            const { data } = await api.post(`${API}/options`, { category, value: answer.value });
            setLookupOptions(current => ({ ...current, [category]: [...(current[category] || []), data.option].sort((a, b) => a.value.localeCompare(b.value)) }));
            setter(answer.value); notify(`“${answer.value}” saved to the ${label} dropdown.`);
        } catch (error) { notify(error.response?.data?.message || 'Unable to save option', 'error'); }
    }
    // CP178 A3: "Others (add new computer)" in the Computer assignment dropdown reuses the existing POST /computers/quick endpoint (name + laboratory only).
    // Only computerId changes - every other unsaved Equipment form field is left exactly as typed. Cancel keeps the previous selection.
    const ADD_COMPUTER_VALUE = '__add_computer__';
    async function chooseAddComputer() {
        if (busyRef.current) return;
        if (!labId) { notify('Select a laboratory first, then add the computer to it.', 'error'); return; }
        busyRef.current = true;
        try {
            const typed = await prompt('Enter the new computer name:', { title: 'Add computer', placeholder: 'e.g. PC-21', confirmLabel: 'Add computer' });
            const name = String(typed ?? '').trim().replace(/\s+/g, ' ');
            if (!name) return; // cancelled or blank: nothing created, selection unchanged
            const sameLab = computers.filter((computer) => Number(computer.laboratory_id) === Number(labId));
            const existing = sameLab.find((computer) => String(computer.computer_name || computer.name || '').trim().toLowerCase() === name.toLowerCase());
            if (existing) { setComputerId(String(existing.id)); notify(`“${existing.computer_name || existing.name}” already exists in this laboratory and was selected.`); return; }
            try {
                const { data } = await api.post(`${API}/computers/quick`, { computer_name: name, laboratory_id: Number(labId) });
                const created = data.computer;
                setComputers((current) => [...current, created]);
                setComputerId(String(created.id));
                notify(`Computer “${created.computer_name}” added and selected. Complete its specifications later on the Computers page.`);
            } catch (error) { notify(error.response?.data?.message || 'Unable to add computer', 'error'); }
        } finally { busyRef.current = false; }
    }
    async function loadAll() {
        setLoading(true)
        await Promise.all([loadEquipment(), loadLabs(), loadComputers()])
        setLoading(false)
    }
    async function loadEquipment() {
        try {
            const { data } = await api.get(`${API}/equipment`)
            setEquipment(data.equipment || [])
        } catch (error) {
            notify(
                error.response?.data?.message || 'Unable to load equipment',
                'error'
            )
        }
    }
    async function loadLabs() {
        try {
            const { data } = await api.get(`${API}/laboratories`)
            setLabs(data.laboratories || [])
        } catch (error) {
            console.error('Unable to load laboratories:', error)
        }
    }
    async function loadComputers() {
        try {
            const { data } = await api.get(`${API}/computers`)
            setComputers(data.computers || [])
        } catch (error) {
            console.error('Unable to load computers:', error)
        }
    }
    function notify(text, type = 'success') {
        setAlert({ text, type })
    }
    function labName(id) {
        const lab = labs.find((item) => Number(item.id) === Number(id))
        return lab?.laboratory_name || lab?.name || `Laboratory ${id || 'Unassigned'}`
    }
    function computerDetails(id) {
        return computers.find(computer => Number(computer.id) === Number(id)) || null
    }
    function computerName(id) {
        const item = computerDetails(id)
        return item?.computer_name || item?.name || 'Not assigned'
    }
    function clearForm() {
        setEditing(null)
        setType('')
        setLabId('')
        setComputerId('')
        setAssetTag('')
        setSerialNumber('')
        setBrand('')
        setModel('')
        setStatus('WORKING')
        setEquipmentState('ACTIVE')
        setConditionNote('')
    }
    function openAdd() {
        clearForm()
        setModalOpen(true)
    }
    function closeModal() {
        if (saving) return
        setModalOpen(false)
        clearForm()
    }
    function openEdit(item) { const standard = TYPES.some(([value]) => value === item.equipment_type && value !== 'OTHER'); const knownCustom = equipment.some((record) => record.equipment_type === item.equipment_type) || lookupOptions.equipment_type.some((option) => option.value === item.equipment_type); setEditing(item); setType(item.equipment_type || ''); setLabId(String(item.laboratory_id || '')); setComputerId(String(item.computer_id || '')); setAssetTag(item.asset_tag || ''); setSerialNumber(item.serial_number || ''); setBrand(item.brand || ''); setModel(item.model || ''); setStatus(item.status || 'WORKING'); setEquipmentState(item.equipment_state || 'ACTIVE'); setConditionNote(item.condition_note || ''); setModalOpen(true) }
    function payload() { return { equipment_type: type, laboratory_id: labId, computer_id: computerId || null, asset_tag: assetTag.trim(), serial_number: serialNumber.trim(), brand: brand.trim(), model: model.trim(), status, equipment_state: equipmentState, condition_note: conditionNote.trim() } }
    async function submit(event) { event.preventDefault(); if (busyRef.current) return; busyRef.current = true; try { await submitConfirmed() } finally { busyRef.current = false } }
    async function submitConfirmed() { if (!await confirm(`${editing ? 'Save changes to' : 'Add'} this equipment record?`)) return; setSaving(true); try { const response = editing ? await api.put(`${API}/equipment/${editing.id}`, payload()) : await api.post(`${API}/equipment`, payload()); const sentToMaintenance = response.data.maintenance?.action === 'created'; await loadEquipment(); notify(`${editing ? 'Equipment updated successfully' : 'Equipment added successfully'}${sentToMaintenance ? '. It is Not Working, so a Maintenance record was opened.' : ''}`); setModalOpen(false); clearForm() } catch (error) { notify(error.response?.data?.message || 'Unable to save equipment', 'error') } finally { setSaving(false) } }
    async function exportEquipment() {
        try {
            const { data } = await api.post(`${API}/equipment/export`, { rows: visible }, { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'CLMS_Equipment_Export.xlsx'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.URL.revokeObjectURL(url);
            notify(`Exported ${visible.length} filtered equipment record(s).`);
            await noticeDialog(`Exported ${visible.length} equipment record(s) to CLMS_Equipment_Export.xlsx.`, { title: 'Export complete' });
        } catch (error) { notify(error.response?.data?.message || 'Unable to export equipment records.', 'error'); }
    }
    // Save as PDF: every equipment record matching the current search (all pages), US Letter with the PTC header.
    async function saveEquipmentPdf() {
        try {
            await printHtmlDocument(buildEquipmentPdfHtml(visible, { labName, computerName, computerDetails, search: searchTerm.trim(), logoBase: window.location.origin }))
        } catch {
            notify('Unable to prepare the PDF. Please try again.', 'error')
        }
    }

    // Shared by "Delete selected" and "Delete All". Equipment referenced by maintenance history is skipped when deleting all.
    async function runEquipmentDelete(ids, { all = false } = {}) {
        try {
            const { data } = await api.post(`${API}/equipment/bulk-delete`, { ids, skipLinked: all })
            setSelectedEquipmentIds([])
            await loadAll()
            undoToast(deletedMessage(data, 'Equipment deleted.'), async () => {
                const restored = await api.post(`${API}/equipment/undo-bulk-delete/${data.undoActionId}`)
                await loadAll()
                return restored.data.message || 'Equipment records restored.'
            }, { label: 'Restore', title: 'Deleted' })
        } catch (error) { notify(error.response?.data?.message || 'Unable to delete equipment.', 'error') }
    }
    // Delete All = delete ONLY the selected records that are still in the current (searched) list. An empty selection
    // does nothing (the button is disabled and this guard returns), so it can never delete every record by accident.
    async function deleteAllEquipment() {
        const ids = selectedEquipmentIds.filter(id => visible.some(item => Number(item.id) === id))
        if (!ids.length) { notify('Select at least one equipment record first.', 'error'); return }
        if (ids.length > 5000) { notify('Delete at most 5,000 equipment records at a time. Use search to narrow the list.', 'error'); return }
        if (!await confirm(`Delete ${ids.length} selected equipment record${ids.length === 1 ? '' : 's'}? Records still referenced by maintenance history are skipped. You can restore them afterwards.`, { title: 'Delete All equipment', confirmLabel: 'Delete All', danger: true })) return
        await runEquipmentDelete(ids, { all: true })
    }
    function selectAllEquipment() { setSelectedEquipmentIds(visible.map(item => Number(item.id))) }
    function clearEquipmentSelection() { setSelectedEquipmentIds([]) }
    async function remove(id) { if (!await confirm('Delete this equipment record? You can restore it afterwards. Records referenced by maintenance history cannot be deleted.')) return; try { const { data } = await api.post(`${API}/equipment/bulk-delete`, { ids: [id] }); const singleUndoId = data.undoActionId; undoToast(deletedMessage(data, 'Equipment deleted.'), async () => { const restored = await api.post(`${API}/equipment/undo-bulk-delete/${singleUndoId}`); await loadAll(); return restored.data.message || 'Equipment restored.' }, { label: 'Restore', title: 'Deleted' }); setEquipment((items) => items.filter((item) => Number(item.id) !== Number(id))); setSelectedEquipmentIds(current => current.filter(selectedId => selectedId !== Number(id)))} catch (error) { notify(error.response?.data?.message || 'Unable to delete equipment', 'error') } }
    async function logout() {
        await logoutSession()
        navigate('/')
    }

    const search = searchTerm.trim().toLowerCase()
    const visible = equipment.filter(item => !search || [item.equipment_type, item.brand, item.model, labName(item.laboratory_id ?? item.effective_laboratory_id), computerName(item.computer_id), item.asset_tag, item.serial_number, item.status, item.condition_note, item.added_by_name, item.reported_by_name, item.report_date, item.reported_by_username].some(value => String(value ?? '').toLowerCase().includes(search)))
    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
    const safePage = Math.min(currentPage, totalPages)
    const pageEquipment = visible.slice((safePage - 1) * pageSize, safePage * pageSize)
    // Typed page numbers are clamped to 1..totalPages; an empty / invalid entry returns to the current page.
    function goToPage(value) {
        const wanted = Number.parseInt(value, 10)
        const next = Number.isInteger(wanted) ? Math.min(Math.max(1, wanted), totalPages) : safePage
        setCurrentPage(next); setPageInput(String(next))
    }
    // Counters use every saved record (not the search filter) and ignore letter case / spaces in the stored condition.
    useEffect(() => { setPageInput(String(safePage)) }, [safePage])
    const working = equipment.filter((item) => ['WORKING', 'ACTIVE'].includes(norm(item.status))).length
    const attention = equipment.filter((item) => !['', 'WORKING', 'ACTIVE', 'INACTIVE', 'RETIRED'].includes(norm(item.status))).length
    const allVisibleSelected = visible.length > 0 && visible.every(item => selectedEquipmentIds.includes(Number(item.id)))
    const complete = Boolean(type && labId && assetTag.trim() && serialNumber.trim() && true && (!needsNote(status) || conditionNote.trim()))
    // Custom types already used by saved records remain selectable without duplicating standard options.
    // Only rows from lookup_options are custom (deletable). Built-in values and values that merely appear on records never get a delete symbol.
    async function deleteCustomLookup(category, label, option, selectedValue, resetSelection) {
        if (!await confirm(`Delete the custom ${label} option “${option.value}” from the dropdown? Existing records keep their value.`, { title: 'Delete custom option', confirmLabel: 'Delete', danger: true })) return
        try {
            const { data } = await api.delete(`${API}/options/${option.id}`)
            setLookupOptions(current => ({ ...current, [category]: (current[category] || []).filter(item => item.id !== option.id) }))
            if (String(selectedValue) === String(option.value)) resetSelection()
            feedback(data.message || 'Custom option deleted.')
        } catch (error) { notify(error.response?.data?.message || 'Unable to delete the option. Nothing was changed.', 'error') }
    }
    const customEntry = (category, value) => (lookupOptions[category] || []).find(option => String(option.value).toLowerCase() === String(value).toLowerCase())
    const equipmentTypeOptions = [...TYPES.filter(([value]) => value !== 'OTHER' || type === 'OTHER'), ...[...new Set([...equipment.map((item) => String(item.equipment_type || '').trim()), ...lookupOptions.equipment_type.map((option) => option.value)].filter((value) => value && !TYPES.some(([standard]) => standard === value)))].map((value) => [value, pretty(value)])]

    const pageContent = (
        <div className="equipment-page">
            <div className="equipment-overlay" />
            {!isMIS && (
                <header className="equipment-header">
                    <button className="equipment-brand" type="button" onClick={() => navigate('/inventory-dashboard')}>
                        <span className="equipment-brand-logo"><img src="/clms-logo.png" alt="CLMS Logo" /></span>
                        <span><strong>CLMS</strong><small>Pateros Technological College</small></span>
                    </button>
                    <div className="equipment-user">
                        <span className="equipment-avatar">{user.full_name?.charAt(0)?.toUpperCase() || 'I'}</span>
                        <span className="equipment-user-info"><strong>{user.full_name || 'MIS Staff'}</strong><small>MIS Staff</small></span>
                    </div>
                </header>
            )}

            <div className="equipment-layout">
                {!isMIS && (
                    <aside className="equipment-sidebar">
                        <div className="equipment-sidebar-title">MAIN MENU</div>
                        <button type="button" className="equipment-nav-button" onClick={() => navigate('/inventory-dashboard')}>Dashboard</button>
                        <button type="button" className="equipment-nav-button active">Equipment</button>
                        <button type="button" className="equipment-nav-button" onClick={() => navigate('/maintenance')}>Maintenance</button>
                        <button type="button" className="equipment-nav-button" onClick={() => navigate('/maintenance-history')}>Maintenance History</button>
                        <button type="button" className="equipment-nav-button" onClick={() => navigate('/reports')}>Reports</button>
                        <button type="button" className="equipment-nav-button" onClick={() => navigate('/change-password')}>Change Password</button>
                        <div className="equipment-sidebar-divider" />
                        <button type="button" className="equipment-nav-button logout" onClick={logout}>Logout</button>
                    </aside>
                )}

                <main className={`equipment-main${isMIS ? ' equipment-main-mis' : ''}`}>
                    <section className="equipment-heading">
                        <h1>Equipments</h1>
                    </section>



                    <section className="equipment-panel glass-card equipment-reservations-style">
                        {/* CP164: search, context boxes and actions share ONE aligned line (same look as the Reservations toolbar). */}
                        <div className="equipment-toolbar-line no-print">
                            <input id="equipment-search" aria-label="Search equipment" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1); setSelectedEquipmentIds([]) }} placeholder="Search type, laboratory, PC, asset tag, serial, brand, model, status, condition, notes…" />
                            <div className="equipment-context-boxes" aria-label="Equipment summary">
                                <div><span>Total assets</span><strong>{equipment.length}</strong></div>
                                <div><span>Working</span><strong>{working}</strong></div>
                                <div><span>Needs attention</span><strong>{attention}</strong></div>
                            </div>
                            <button type="button" className="equipment-line-button" onClick={openAdd}>+ Add Equipment</button>
                            <FileActionsMenu module="equipment" role={user.role} pdf={canSaveEquipmentPdf(user.role)} buttonClassName="equipment-line-button" importProps={{ endpoint: "/equipment", onImported: loadAll, label: "equipment", fixedLayout: true, fieldLabels: { equipment_state: "status", status: "condition" } }} onExport={exportEquipment} onPdf={saveEquipmentPdf} />
                            {canManageEquipment && <button type="button" className="equipment-line-button" onClick={() => allVisibleSelected ? clearEquipmentSelection() : selectAllEquipment()} disabled={!visible.length}>{allVisibleSelected ? 'Clear Selection' : 'Select All'}</button>}
                            {canManageEquipment && <button type="button" className="equipment-line-button equipment-line-delete clms-delete-all" onClick={deleteAllEquipment} disabled={!selectedEquipmentIds.length}>{selectedEquipmentIds.length ? `Delete Selected (${selectedEquipmentIds.length})` : 'Delete All'}</button>}
                        </div>
                        <div className="equipment-table-wrap">
                            <table className="equipment-table">
                                <thead><tr>{canManageEquipment && <th><input type="checkbox" aria-label="Select all equipment on this page" checked={pageEquipment.length > 0 && pageEquipment.every(item => selectedEquipmentIds.includes(Number(item.id)))} onChange={event => setSelectedEquipmentIds(current => event.target.checked ? [...new Set([...current, ...pageEquipment.map(item => Number(item.id))])] : current.filter(id => !pageEquipment.some(item => Number(item.id) === id)))} /></th>}<th>Equipment Type</th><th>Laboratory</th><th>Computer Assignment</th><th>Asset Tag &amp; Serial Number</th><th>Status</th><th>Condition</th><th>Added By</th><th>Added Date</th><th>Actions</th></tr></thead>
                                <tbody>
                                    {loading ? <tr><td colSpan={canManageEquipment ? 10 : 9} className="equipment-empty">Loading equipment records...</td></tr>
                                        : visible.length === 0 ? <tr><td colSpan={canManageEquipment ? 10 : 9} className="equipment-empty">No equipment matches this view.</td></tr>
                                        : pageEquipment.map((item) => (
                                            <tr key={item.id}>
                                                {canManageEquipment && <td><input type="checkbox" aria-label={`Select equipment ${item.asset_tag || item.id}`} checked={selectedEquipmentIds.includes(Number(item.id))} onChange={event => setSelectedEquipmentIds(current => event.target.checked ? [...new Set([...current, Number(item.id)])] : current.filter(id => id !== Number(item.id)))} /></td>}
                                                <td><strong>{pretty(item.equipment_type)}</strong><small>{item.brand || 'Unbranded'} {item.model || ''}</small></td>
                                                <td>{labName(item.laboratory_id ?? item.effective_laboratory_id)}</td>
                                                <td>{item.computer_id ? <><strong>{computerName(item.computer_id)}</strong>{computerDetails(item.computer_id)?.condition_note && <small className="equipment-condition-note">Condition note: {computerDetails(item.computer_id).condition_note}</small>}</> : <span className="equipment-muted">Not assigned</span>}</td>
                                                <td><strong>{item.asset_tag}</strong><small>SN: {item.serial_number}</small></td>
                                                <td><span className={`equipment-status ${norm(item.equipment_state || 'ACTIVE') === 'INACTIVE' ? 'inactive' : norm(item.equipment_state || 'ACTIVE') === 'ACTIVE' ? 'active' : 'not-working'}`}>{pretty(item.equipment_state || 'ACTIVE')}</span></td>
                                                <td><span className={`equipment-status ${statusClass(item.status)}`}>{norm(item.status) === 'ACTIVE' ? 'Working' : pretty(item.status)}</span>{item.condition_note && <small className="equipment-condition-note">{item.condition_note}</small>}</td>
                                                <td>{item.added_by_name || item.reported_by_name || "—"}</td><td>{item.report_date ? new Date(item.report_date).toLocaleString() : "—"}</td>
                                                <td><div className="equipment-row-actions"><button type="button" onClick={() => openEdit(item)}>Edit</button><button type="button" className="danger" onClick={() => remove(item.id)}>Delete</button></div></td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                        {visible.length > 0 && <div className="equipment-pagination no-print"><span>Showing {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visible.length)} of {visible.length} assets</span>
                            <button type="button" onClick={() => goToPage(safePage - 1)} disabled={safePage <= 1}>Previous</button>
                            <label className="equipment-page-jump">Page <input type="text" inputMode="numeric" aria-label="Page number" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={() => goToPage(pageInput)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goToPage(pageInput) } }} /> of {totalPages}</label>
                            <button type="button" onClick={() => goToPage(safePage + 1)} disabled={safePage >= totalPages}>Next</button></div>}
                    </section>
                </main>
            </div>

            {modalOpen && <div className="equipment-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
                <section className="equipment-modal" role="dialog" aria-modal="true" aria-labelledby="equipment-modal-title">
                    <div className="equipment-modal-header"><div><h2 id="equipment-modal-title">{editing ? 'Edit equipment' : 'Add equipment'}</h2></div><button type="button" className="equipment-close" onClick={closeModal} aria-label="Close">✖</button></div>
                    <form onSubmit={submit}>
                        <div className="equipment-form-grid">
                            <label>Equipment type<OptionSelect required ariaLabel="Equipment type" placeholder="Select type" value={type} options={[{ value: '', label: 'Select type', custom: false }, ...equipmentTypeOptions.map(([value, label]) => { const row = TYPES.some(([standard]) => standard === value) ? null : customEntry('equipment_type', value); return { value, label, custom: Boolean(row), id: row?.id } })].filter(option => option.value !== '')} onChange={setType} onOthers={() => chooseOtherLookup('equipment_type', 'equipment type', equipmentTypeOptions.map(([value]) => value), setType)} onDeleteCustom={option => deleteCustomLookup('equipment_type', 'equipment type', { id: option.id, value: option.value }, type, () => setType(''))} /></label>
                            <label>Laboratory<select required value={labId} onChange={(event) => { setLabId(event.target.value); setComputerId('') }}><option value="">Select laboratory</option>{labs.map((lab) => <option key={lab.id} value={lab.id}>{lab.laboratory_name || lab.name}</option>)}</select></label>
                            <label>Computer assignment<select required value={computerId} onChange={(event) => event.target.value === ADD_COMPUTER_VALUE ? chooseAddComputer() : setComputerId(event.target.value)}><option value="">Select PC assignment</option>{computers.filter((computer) => !labId || Number(computer.laboratory_id) === Number(labId)).map((computer) => <option key={computer.id} value={computer.id}>{computer.computer_name || computer.name}</option>)}<option value={ADD_COMPUTER_VALUE}>Others (add new computer)</option></select></label>
                            <label>Asset tag<input required value={assetTag} onChange={(event) => setAssetTag(event.target.value)} placeholder="e.g. EQ-2026-001" /></label>
                            <label>Serial number<input required value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} /></label>
                            <label>Brand<input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Optional" /></label>
                            <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Optional" /></label>
                            <label>Status<OptionSelect required ariaLabel="Status" value={equipmentState} options={[...new Set([...STATES.map(([value]) => value), ...lookupOptions.equipment_state.map(option => option.value), ...(equipmentState ? [equipmentState] : [])])].map(value => { const row = STATES.some(([standard]) => standard === value) ? null : customEntry('equipment_state', value); return { value, label: pretty(value), custom: Boolean(row), id: row?.id } })} onChange={setEquipmentState} onOthers={() => chooseOtherLookup('equipment_state', 'status', [...STATES.map(([value]) => value), ...lookupOptions.equipment_state.map(option => option.value)], setEquipmentState)} onDeleteCustom={option => deleteCustomLookup('equipment_state', 'status', { id: option.id, value: option.value }, equipmentState, () => setEquipmentState('ACTIVE'))} /></label>
                            <label>Condition<OptionSelect required ariaLabel="Condition" value={status} options={[...new Set([...STATUSES.map(([value]) => value), ...lookupOptions.equipment_status.map(option => option.value), ...(status ? [status] : [])])].map(value => { const row = STATUSES.some(([standard]) => standard === value) ? null : customEntry('equipment_status', value); return { value, label: pretty(value), custom: Boolean(row), id: row?.id } })} onChange={value => { setStatus(value); if (!needsNote(value)) setConditionNote('') }} onOthers={() => chooseOtherLookup('equipment_status', 'condition', [...STATUSES.map(([value]) => value), ...lookupOptions.equipment_status.map(option => option.value)], value => { setStatus(value); if (!needsNote(value)) setConditionNote('') })} onDeleteCustom={option => deleteCustomLookup('equipment_status', 'condition', { id: option.id, value: option.value }, status, () => setStatus('WORKING'))} /></label>
                            {needsNote(status) && <label className="equipment-full-field">Condition note<textarea required rows="3" value={conditionNote} onChange={(event) => setConditionNote(event.target.value)} placeholder="Describe the current condition or issue" /></label>}
                        </div>
                        <div className="equipment-modal-actions"><button type="button" className="equipment-secondary-button" onClick={closeModal}>Cancel</button><button type="submit" className="equipment-primary-button" disabled={!complete || saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Save equipment'}</button></div>
                    </form>
                </section>
            </div>}
        </div>
    )

    return isMIS ? <MISPageShell active="equipment">{pageContent}</MISPageShell> : pageContent

}

export default Equipment