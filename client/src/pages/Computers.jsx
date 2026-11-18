import { deletedMessage } from '../utils/deleteInfo.js'
import PagePager from '../components/PagePager.jsx'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx';
import OptionSelect from '../components/OptionSelect.jsx';
import { useEffect, useState } from 'react';
import api, { logoutSession } from '../api';
import { useNavigate } from 'react-router-dom';
import './Computers.css';
import FileActionsMenu from '../components/FileActionsMenu.jsx';
import { buildComputersPdfHtml } from '../utils/computersPdf.js';
import { printHtmlDocument } from '../utils/pdfPrint.js';

function Computers() {
    const { confirm, notify, undoToast, askNewOption, feedback } = useClmsDialog();
    const [computers, setComputers] = useState([]);
    const [laboratories, setLaboratories] = useState([]);
    const [lookupOptions, setLookupOptions] = useState({ computer_storage_unit: [], computer_storage_type: [], computer_status: [], computer_condition: [] });
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 5; // CP187: 5 rows per page; typed page number + Previous / Next
    const [computerName, setComputerName] = useState('');
    const [laboratoryId, setLaboratoryId] = useState('');
    const [assetTag, setAssetTag] = useState('');
    const [serialNumber, setSerialNumber] = useState('');
    const [processor, setProcessor] = useState('');
    const [ram, setRam] = useState('');
    const [storageCapacity, setStorageCapacity] = useState('');
    const [storageUnit, setStorageUnit] = useState('GB');
    const [storageType, setStorageType] = useState('SSD');
    const [operationalStatus, setOperationalStatus] = useState('ACTIVE');
    const [condition, setCondition] = useState('WORKING');
    const [conditionNote, setConditionNote] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [editingComputer, setEditingComputer] = useState(null);
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('');
    useCenteredFeedback(message, messageType, () => setMessage(''));
    const [selectedComputerIds, setSelectedComputerIds] = useState([]);

    const navigate = useNavigate();
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const isMIS = user?.role === 'MIS';
    const isInventory = user?.role === 'Inventory Staff';
    const canManage = isMIS || isInventory; // MIS Staff may add/edit/delete; import is MIS + MIS Staff

    async function getComputers() {
        try {
            const response = await api.get('/computers');
            setComputers(response.data.computers);
        } catch (error) {
            console.error('Unable to retrieve computers:', error.response?.data?.message || error.message);
        }
    }

    async function getLaboratories() {
        try {
            const response = await api.get('/laboratories');
            setLaboratories(response.data.laboratories);
        } catch (error) {
            console.error('Unable to retrieve laboratories:', error.response?.data?.message || error.message);
        }
    }


    useEffect(() => {
        if (!isMIS && !isInventory) {
            navigate('/');
            return undefined;
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect -- trigger async API loads on entry
        getComputers();
        getLaboratories();
        loadLookupOptions();
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            api.get('/computers').then(response => setComputers(response.data.computers || [])).catch(() => {});
            api.get('/laboratories').then(response => setLaboratories(response.data.laboratories || [])).catch(() => {});
        };
        const timer = window.setInterval(refresh, 5000);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [isMIS, isInventory, navigate]);

    async function loadLookupOptions() {
        const categories = ['computer_storage_unit', 'computer_storage_type', 'computer_status', 'computer_condition'];
        const entries = await Promise.all(categories.map(async category => {
            try { const response = await api.get('/options', { params: { category } }); return [category, response.data.options || []]; }
            catch (error) { console.error(`Unable to load ${category} options:`, error.response?.data?.message || error.message); return [category, []]; }
        }));
        setLookupOptions(Object.fromEntries(entries));
    }

    const OTHERS = '__OTHERS__';
    const BUILT_INS = { computer_storage_unit: ['GB', 'TB'], computer_storage_type: ['SSD', 'HDD'], computer_status: ['ACTIVE', 'INACTIVE'], computer_condition: ['WORKING', 'NOT WORKING'] };
    // Dropdown entries for OptionSelect. Only rows from lookup_options are custom (deletable); built-in values and a
    // record's own historical value are shown but never get a delete symbol.
    const optionEntries = (category, current) => {
        const builtIns = BUILT_INS[category].map(value => ({ value, label: value, custom: false }));
        const custom = (lookupOptions[category] || []).filter(option => !BUILT_INS[category].some(item => item.toLowerCase() === String(option.value).toLowerCase())).map(option => ({ value: option.value, label: option.value, custom: true, id: option.id }));
        const known = new Set([...builtIns, ...custom].map(item => item.value));
        return [...builtIns, ...custom, ...(current && !known.has(current) ? [{ value: current, label: current, custom: false }] : [])];
    };
    async function deleteCustomOption(category, label, option, selectedValue, resetSelection) {
        if (!await confirm(`Delete the custom ${label} option “${option.value}” from the dropdown? Existing records keep their value.`, { title: 'Delete custom option', confirmLabel: 'Delete', danger: true })) return;
        try {
            const response = await api.delete(`/options/${option.id}`);
            setLookupOptions(current => ({ ...current, [category]: (current[category] || []).filter(item => item.id !== option.id) }));
            if (String(selectedValue) === String(option.value)) resetSelection();
            feedback(response.data.message || 'Custom option deleted.');
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to delete the option. Nothing was changed.'); setMessageType('error'); }
    }
    const optionValues = (category, current) => [...new Set([...BUILT_INS[category], ...(lookupOptions[category] || []).map(option => option.value), ...(current ? [current] : [])])];

    // "Others": popup to type a value -> Cancel/Confirm -> saved permanently in lookup_options -> shown in the dropdown.
    async function chooseOther(category, label, setter) {
        const existing = optionValues(category);
        const answer = await askNewOption(label, existing);
        if (!answer) return; // cancelled: nothing saved, selection unchanged
        if (answer.existing) { setter(answer.value); return; }
        try {
            const response = await api.post('/options', { category, value: answer.value });
            setLookupOptions(current => ({ ...current, [category]: [...(current[category] || []), response.data.option].sort((a, b) => a.value.localeCompare(b.value)) }));
            setter(answer.value);
            setMessage(`“${answer.value}” saved to the ${label} dropdown.`); setMessageType('success');
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to save option'); setMessageType('error'); }
    }
    function lookupChange(category, label, setter, extra) {
        return event => { if (event.target.value === OTHERS) chooseOther(category, label, setter); else { setter(event.target.value); extra?.(event); } };
    }

    function resetForm() {
        setComputerName('');
        setLaboratoryId('');
        setAssetTag('');
        setSerialNumber('');
        setProcessor('');
        setRam('');
        setStorageCapacity('');
        setStorageUnit('GB');
        setStorageType('SSD');
        setOperationalStatus('ACTIVE');
        setCondition('WORKING');
        setConditionNote('');
        setEditingComputer(null);
    }

    function handleAddButton() {
        resetForm();
        setShowModal(true);
    }

    async function handleAddComputer() {
        try {
            const response = await api.post('/computers', {
                computer_name: computerName,
                laboratory_id: laboratoryId,
                asset_tag: assetTag,
                serial_number: serialNumber,
                processor,
                ram,
                storage_capacity: storageCapacity,
                storage_unit: storageUnit,
                storage_type: storageType,
                operational_status: operationalStatus,
                condition,
                condition_note: conditionNote
            });
            setComputers([...computers, response.data.computer]);
            setMessage('Computer added successfully');
            setMessageType('success');
            resetForm();
            setShowModal(false);
        } catch (error) {
            console.error('Unable to create computer:', error.response?.data?.message || error.message);
            setMessage(error.response?.data?.message || 'Unable to create computer');
            setMessageType('error');
        }
    }

    function handleEditComputer(computer) {
        setEditingComputer(computer);
        setComputerName(computer.computer_name);
        setLaboratoryId(computer.laboratory_id);
        setAssetTag(computer.asset_tag);
        setSerialNumber(computer.serial_number);
        setProcessor(computer.processor);
        setRam(computer.ram);
        setStorageCapacity(computer.storage_capacity);
        setStorageUnit(computer.storage_unit);
        setStorageType(computer.storage_type);
        setOperationalStatus(computer.operational_status);
        setCondition(computer.condition);
        setConditionNote(computer.condition_note || '');
        setShowModal(true);
    }

    async function handleSubmitComputer(event) {
        event.preventDefault();
        if (!await confirm(`${editingComputer === null ? 'Add' : 'Save'} these computer details?`)) return;
        if (editingComputer === null) {
            await handleAddComputer();
        } else {
            await handleUpdateComputer();
        }
    }

    async function handleUpdateComputer() {
        try {
            const response = await api.put(`/computers/${editingComputer.id}`, {
                computer_name: computerName,
                laboratory_id: laboratoryId,
                asset_tag: assetTag,
                serial_number: serialNumber,
                processor,
                ram,
                storage_capacity: storageCapacity,
                storage_unit: storageUnit,
                storage_type: storageType,
                operational_status: operationalStatus,
                condition,
                condition_note: conditionNote
            });
            setComputers(
                computers.map((c) =>
                    Number(c.id) === Number(editingComputer.id) ? response.data.computer : c
                )
            );
            setMessage('Computer updated successfully');
            setMessageType('success');
            resetForm();
            setShowModal(false);
        } catch (error) {
            console.error('Unable to update computer:', error.response?.data?.message || error.message);
            setMessage(error.response?.data?.message || 'Unable to update computer');
            setMessageType('error');
        }
    }

    async function exportComputers() {
        try {
            const response = await api.post('/computers/export', { rows: visibleComputers }, { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'CLMS_Computers_Export.xlsx'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.URL.revokeObjectURL(url);
            setMessage(`Exported ${visibleComputers.length} filtered computer record(s).`); setMessageType('success');
            await notify(`Exported ${visibleComputers.length} computer record(s) to CLMS_Computers_Export.xlsx.`, { title: 'Export complete' });
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to export computer records.'); setMessageType('error'); }
    }

    // Save as PDF: every computer matching the current search (all pages), US Letter with the PTC header.
    async function saveComputersPdf() {
        try {
            await printHtmlDocument(buildComputersPdfHtml(visibleComputers, { laboratories, search: searchTerm.trim(), logoBase: window.location.origin }));
        } catch {
            setMessage('Unable to prepare the PDF. Please try again.'); setMessageType('error');
        }
    }

    // Shared by "Delete selected" and "Delete All". Linked computers (equipment / maintenance history) are skipped when deleting all.
    async function runComputerDelete(ids, { all = false } = {}) {
        try {
            const response = await api.post('/computers/bulk-delete', { ids, skipLinked: all });
            const { undoActionId, message: resultMessage } = response.data;
            setSelectedComputerIds([]);
            setMessage(resultMessage || 'Computers deleted.'); setMessageType('success');
            await getComputers();
            undoToast(deletedMessage(response.data, 'Computers deleted.'), async () => {
                const restored = await api.post(`/computers/undo-bulk-delete/${undoActionId}`);
                await getComputers();
                return restored.data.message || 'Computer records restored.';
            }, { label: 'Restore', title: 'Deleted' });
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to delete computers.'); setMessageType('error'); }
    }
    async function handleBulkDeleteComputers() {
        if (!selectedComputerIds.length) return;
        if (!await confirm(`Delete ${selectedComputerIds.length} selected computer record(s)? You can restore them afterwards. Computers linked to equipment or maintenance history cannot be deleted.`, { title: 'Delete computers', confirmLabel: 'Delete', danger: true })) return;
        await runComputerDelete(selectedComputerIds);
    }
    async function handleDeleteAllComputers() {
        const ids = visibleComputers.map(item => Number(item.id));
        if (!ids.length) { setMessage('There are no computers to delete.'); setMessageType('error'); return; }
        if (ids.length > 5000) { setMessage('Delete at most 5,000 computers at a time. Use search to narrow the list.'); setMessageType('error'); return; }
        if (!await confirm(`Delete all ${ids.length} listed computer record(s)? Computers that are still linked to equipment or maintenance history are skipped. You can restore them afterwards.`, { title: 'Delete All computers', confirmLabel: 'Delete All', danger: true })) return;
        await runComputerDelete(ids, { all: true });
    }
    function toggleSelectAllComputers() {
        // Select All only selects (every computer in the current searched list, all pages); Clear Selection clears.
        setSelectedComputerIds(visibleComputers.map(item => Number(item.id)));
    }
    function handleClearComputerSelection() { setSelectedComputerIds([]); }

    async function handleDeleteComputer(id) {
        const confirmed = await confirm('Delete this computer? You can restore it afterwards. Computers linked to equipment or maintenance history cannot be deleted.');
        if (!confirmed) return;

        try {
            const response = await api.post('/computers/bulk-delete', { ids: [id] });
            const singleUndoId = response.data.undoActionId;
            setMessage(response.data.message || 'Computer deleted.');
            setMessageType('success');
            undoToast(deletedMessage(response.data, 'Computer deleted.'), async () => {
                const restored = await api.post(`/computers/undo-bulk-delete/${singleUndoId}`);
                await getComputers();
                return restored.data.message || 'Computer restored.';
            }, { label: 'Restore', title: 'Deleted' });
            setSelectedComputerIds(current => current.filter(selectedId => selectedId !== Number(id)));
            setComputers(computers.filter((c) => Number(c.id) !== Number(id)));
        } catch (error) {
            console.error('Unable to delete computer:', error.response?.data?.message || error.message);
            setMessage(error.response?.data?.message || 'Unable to delete computer');
            setMessageType('error');
        }
    }

    function handleConditionChange(event) {
        const newCondition = event.target.value;
        if (newCondition === OTHERS) { chooseOther('computer_condition', 'condition', value => { setCondition(value); if (value === 'WORKING') setConditionNote(''); }); return; }
        setCondition(newCondition);
        if (newCondition === 'WORKING') {
            setConditionNote('');
        }
    }

    function handleCancel() {
        resetForm();
        setShowModal(false);
    }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    function opStatusClass(s) {
        return s === 'ACTIVE' ? 'active' : 'inactive';
    }

    function conditionClass(c) {
        if (c === 'WORKING') return 'working';
        if (c === 'UNDER REPAIR') return 'under-repair';
        if (c === 'DAMAGED') return 'damaged';
        if (c === 'MISSING') return 'missing';
        if (c === 'RETIRED') return 'retired';
        return 'custom'; // CP135: any other (custom) condition is shown in red
    }

    const conditionNeedsNote = condition !== 'WORKING';

    const search = searchTerm.trim().toLowerCase();
    // CP114 summary box: counts ALL computers (not the search-filtered view). Working = condition WORKING; every other
    // condition (UNDER REPAIR, DAMAGED, MISSING, RETIRED, custom ones, or none) needs attention, so Working + Need Attention = Total.
    const totalComputers = computers.length;
    const workingComputers = computers.filter(c => String(c.condition ?? '').trim().toUpperCase() === 'WORKING').length;
    const needAttentionComputers = totalComputers - workingComputers;
    const visibleComputers = computers.filter(c => !search || [c.computer_name, laboratories.find(lab => Number(lab.id) === Number(c.laboratory_id))?.laboratory_name, c.asset_tag, c.serial_number, c.processor, c.ram, c.storage_capacity, c.storage_unit, c.storage_type, c.operational_status, c.condition, c.condition_note].some(value => String(value ?? '').toLowerCase().includes(search)));
    const totalPages = Math.max(1, Math.ceil(visibleComputers.length / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const pageComputers = visibleComputers.slice((safePage - 1) * pageSize, safePage * pageSize);
    const allVisibleComputersSelected = visibleComputers.length > 0 && visibleComputers.every(item => selectedComputerIds.includes(Number(item.id)));

    const isFormComplete =
        computerName &&
        laboratoryId &&
        assetTag &&
        serialNumber &&
        processor &&
        Number.isSafeInteger(Number(ram)) && Number(ram) > 0 &&
        Number.isSafeInteger(Number(storageCapacity)) && Number(storageCapacity) > 0 &&
        storageUnit &&
        storageType &&
        operationalStatus &&
        condition &&
        (!conditionNeedsNote || conditionNote.trim());

    return (
        <div className="computers-page">

            {/* Background overlay */}
            <div className="dashboard-overlay"></div>

            {/* =========================================
                TOP HEADER
            ========================================= */}

            <header className="dashboard-header">

                <div className="brand-section">
                    <div className="brand-logo">
                        <img src="/clms-logo.png" alt="CLMS Logo" />
                    </div>
                    <div className="brand-text">
                        <h1>CLMS</h1>
                        <span>Pateros Technological College</span>
                    </div>
                </div>

                <div className="user-section">
                    <div className="user-avatar">
                        {user?.full_name?.charAt(0)?.toUpperCase() || 'M'}
                    </div>
                    <div className="user-info-header">
                        <strong>{user?.full_name || 'MIS Staff'}</strong>
                        <span>{user?.role || 'MIS'}</span>
                    </div>
                </div>

            </header>

            {/* =========================================
                SIDEBAR + MAIN
            ========================================= */}

            <div className="dashboard-content">

                <aside className="dashboard-sidebar">

                    <div className="sidebar-title">MAIN MENU</div>

                    <button
                        type="button"
                        className="dashboard-button"
                        onClick={() => navigate('/mis-dashboard')}
                    >
                        <span className="button-icon"></span>
                        <span>Dashboard</span>
                    </button>

                    <button
                        type="button"
                        className="dashboard-button"
                        onClick={() => navigate('/users')}
                    >
                        <span className="button-icon"></span>
                        <span>User Management</span>
                    </button>

                    <button
                        type="button"
                        className="dashboard-button"
                        onClick={() => navigate('/laboratories')}
                    >
                        <span className="button-icon"></span>
                        <span>Laboratories</span>
                    </button>

                    <button
                        type="button"
                        className="dashboard-button active"
                    >
                        <span className="button-icon"></span>
                        <span>Computers</span>
                    </button>

                    <button
                        type="button"
                        className="dashboard-button"
                        onClick={() => navigate('/reservations')}
                    >
                        <span className="button-icon"></span>
                        <span>Reservations</span>
                    </button>

                    <button type="button" className="dashboard-button" onClick={() => navigate('/equipment')}>
                        <span className="button-icon"></span><span>Assets &amp; Equipment</span>
                    </button>
                    <button type="button" className="dashboard-button" onClick={() => navigate('/reports')}>
                        <span className="button-icon"></span><span>Reports</span>
                    </button>
                    <button type="button" className="dashboard-button" onClick={() => navigate('/audit-log')}>
                        <span className="button-icon"></span><span>Audit Log</span>
                    </button>
                    <button type="button" className="dashboard-button" onClick={() => navigate('/change-password')}>
                        <span className="button-icon"></span><span>Change Password</span>
                    </button>

                    <div className="sidebar-divider"></div>

                    <button
                        type="button"
                        className="dashboard-button logout-button"
                        onClick={handleLogout}
                    >
                        <span className="button-icon"></span>
                        <span>Logout</span>
                    </button>

                </aside>

                <main className="computers-main">

                    {/* Title bar */}
                    <div className="page-title-bar">
                        <h2>Computers</h2>
                    </div>

                    {/* Alert */}

                    <div className="computers-search-row no-print"><input id="computers-search" type="search" aria-label="Search computers" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1); setSelectedComputerIds([]) }} placeholder="Search name, laboratory, asset tag, serial, specs, status, condition…" />
                        <div className="computers-context-boxes" role="group" aria-label="Computers summary">
                            <div><span>Total Computers</span><strong>{totalComputers}</strong></div>
                            <div><span>Working</span><strong>{workingComputers}</strong></div>
                            <div><span>Need Attention</span><strong>{needAttentionComputers}</strong></div>
                        </div>
                        <div className="toolbar-inline-actions title-actions no-print">
                            {canManage && <button type="button" className="btn-primary" onClick={handleAddButton}>+ Add Computer</button>}
                            <FileActionsMenu module="computers" role={user?.role} pdf={isMIS || isInventory} importProps={{ endpoint: "/computers", onImported: getComputers, label: "computer", fixedLayout: true }} onExport={exportComputers} onPdf={saveComputersPdf} />
                            {canManage && <button type="button" className="btn-primary" onClick={allVisibleComputersSelected ? handleClearComputerSelection : toggleSelectAllComputers} disabled={!visibleComputers.length}>{allVisibleComputersSelected ? "Clear Selection" : "Select All"}</button>}
                            {canManage && selectedComputerIds.length > 0 && <button type="button" className="btn-delete clms-delete-all" onClick={handleBulkDeleteComputers}>Delete selected ({selectedComputerIds.length})</button>}
                            {canManage && <button type="button" className="btn-delete clms-delete-all" onClick={handleDeleteAllComputers} disabled={!visibleComputers.length}>Delete All</button>}
                        </div></div>
                    {/* Table */}
                    <div className="computers-table-wrapper">
                        <table className="computers-table">
                            <thead>
                                <tr>
                                    {canManage && <th><input type="checkbox" aria-label="Select all computers on this page" checked={pageComputers.length > 0 && pageComputers.every(item => selectedComputerIds.includes(Number(item.id)))} onChange={event => setSelectedComputerIds(current => event.target.checked ? [...new Set([...current, ...pageComputers.map(item => Number(item.id))])] : current.filter(id => !pageComputers.some(item => Number(item.id) === id)))} /></th>}
                                    <th>Computer Name</th>
                                    <th>Laboratory</th>
                                    <th>Asset Tag</th>
                                    <th>Serial No.</th>
                                    <th>Processor</th>
                                    <th>RAM</th>
                                    <th>Storage</th>
                                    <th>Status</th>
                                    <th>Condition</th>
                                    {canManage && <th>Actions</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {pageComputers.length === 0 ? <tr><td colSpan={canManage ? 11 : 9} className="computers-empty">No computers match this search.</td></tr> : pageComputers.map((c) => (
                                    <tr key={c.id}>
                                        {canManage && <td><input type="checkbox" aria-label={`Select computer ${c.computer_name || c.id}`} checked={selectedComputerIds.includes(Number(c.id))} onChange={event => setSelectedComputerIds(current => event.target.checked ? [...new Set([...current, Number(c.id)])] : current.filter(id => id !== Number(c.id)))} /></td>}
                                        <td>{c.computer_name}</td>
                                        <td>{laboratories.find(lab => Number(lab.id) === Number(c.laboratory_id))?.laboratory_name || `Lab ${c.laboratory_id}`}</td>
                                        <td>{c.asset_tag}</td>
                                        <td>{c.serial_number}</td>
                                        <td>{c.processor}</td>
                                        <td>{c.ram} GB</td>
                                        <td>{c.storage_capacity} {c.storage_unit} {c.storage_type}</td>
                                        <td>
                                            <span className={`status-badge ${opStatusClass(c.operational_status)}`}>
                                                {c.operational_status}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`condition-badge ${conditionClass(c.condition)}`}>
                                                {c.condition}
                                            </span>
                                            {c.condition_note && <small className="computer-condition-note">{c.condition_note}</small>}
                                        </td>
                                        {canManage && <td>
                                            <div className="table-actions">
                                                <button type="button" className="btn-edit" onClick={() => handleEditComputer(c)}>Edit</button>
                                                <button type="button" className="btn-delete" onClick={() => handleDeleteComputer(c.id)}>Delete</button>
                                            </div>
                                        </td>}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <PagePager className="computers-pagination" ariaLabel="Computer pagination" summary={`Showing ${visibleComputers.length ? (safePage - 1) * pageSize + 1 : 0}–${Math.min(safePage * pageSize, visibleComputers.length)} of ${visibleComputers.length} computers`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />

                </main>

            </div>

            {/* =========================================
                MODAL
            ========================================= */}

            {showModal && (
                <div className="modal-backdrop" onClick={handleCancel}>
                    <div
                        className="modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2>{editingComputer ? 'Edit Computer' : 'Add Computer'}</h2>

                        <form onSubmit={handleSubmitComputer}>

                            <div className="form-group">
                                <label>Laboratory</label>
                                <select
                                    value={laboratoryId}
                                    onChange={(e) => setLaboratoryId(e.target.value)}
                                >
                                    <option value="">Select Laboratory</option>
                                    {laboratories.map((lab) => (
                                        <option key={lab.id} value={lab.id}>
                                            {lab.laboratory_name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Computer Name</label>
                                    <input
                                        type="text"
                                        value={computerName}
                                        placeholder="Enter computer name"
                                        onChange={(e) => setComputerName(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Asset Tag</label>
                                    <input type="text" value={assetTag} placeholder="Enter asset tag" onChange={(e) => setAssetTag(e.target.value)} />
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Serial Number</label>
                                    <input
                                        type="text"
                                        value={serialNumber}
                                        placeholder="Enter serial number"
                                        onChange={(e) => setSerialNumber(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Processor</label>
                                    <input
                                        type="text"
                                        value={processor}
                                        placeholder="e.g. Intel i5-12400"
                                        onChange={(e) => setProcessor(e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className="form-row-3">
                                <div className="form-group">
                                    <label>RAM (GB)</label>
                                    <input
                                        type="number"
                                        value={ram}
                                        placeholder="e.g. 8"
                                        onChange={(e) => setRam(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Storage</label>
                                    <input
                                        type="number"
                                        value={storageCapacity}
                                        placeholder="e.g. 256"
                                        onChange={(e) => setStorageCapacity(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Unit</label>
                                    <OptionSelect ariaLabel="Unit" value={storageUnit} options={optionEntries('computer_storage_unit', storageUnit)} onChange={setStorageUnit} onOthers={() => chooseOther('computer_storage_unit', 'unit', setStorageUnit)} onDeleteCustom={option => deleteCustomOption('computer_storage_unit', 'unit', option, storageUnit, () => setStorageUnit('GB'))} />
                                </div>
                            </div>

                            <div className="form-row-3">
                                <div className="form-group">
                                    <label>Storage Type</label>
                                    <OptionSelect ariaLabel="Storage Type" value={storageType} options={optionEntries('computer_storage_type', storageType)} onChange={setStorageType} onOthers={() => chooseOther('computer_storage_type', 'storage type', setStorageType)} onDeleteCustom={option => deleteCustomOption('computer_storage_type', 'storage type', option, storageType, () => setStorageType('SSD'))} />
                                </div>
                                <div className="form-group">
                                    <label>Status</label>
                                    <OptionSelect ariaLabel="Status" value={operationalStatus} options={optionEntries('computer_status', operationalStatus)} onChange={setOperationalStatus} onOthers={() => chooseOther('computer_status', 'status', setOperationalStatus)} onDeleteCustom={option => deleteCustomOption('computer_status', 'status', option, operationalStatus, () => setOperationalStatus('ACTIVE'))} />
                                </div>
                                <div className="form-group">
                                    <label>Condition</label>
                                    <OptionSelect ariaLabel="Condition" value={condition} options={optionEntries('computer_condition', condition)} onChange={value => handleConditionChange({ target: { value } })} onOthers={() => handleConditionChange({ target: { value: OTHERS } })} onDeleteCustom={option => deleteCustomOption('computer_condition', 'condition', option, condition, () => { setCondition('WORKING'); setConditionNote(''); })} />
                                </div>
                            </div>

                            {conditionNeedsNote && (
                                <div className="form-group">
                                    <label>Condition Note</label>
                                    <textarea
                                        value={conditionNote}
                                        onChange={(e) => setConditionNote(e.target.value)}
                                        placeholder="Enter reason for this condition"
                                        required
                                    />
                                </div>
                            )}

                            <div className="modal-actions">
                                <button
                                    type="submit"
                                    className="btn-primary"
                                    disabled={!isFormComplete}
                                >
                                    {editingComputer ? 'Update' : 'Save Computer'}
                                </button>
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={handleCancel}
                                >
                                    Cancel
                                </button>
                            </div>

                        </form>
                    </div>
                </div>
            )}

        

        </div>
    );
}

export default Computers;