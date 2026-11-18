import { deletedMessage } from '../utils/deleteInfo.js'
import PagePager from '../components/PagePager.jsx'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx';
import OptionSelect from '../components/OptionSelect.jsx';
import DatePicker from '../components/DatePicker.jsx';
import FileActionsMenu from '../components/FileActionsMenu.jsx';
import { downloadExcel, exportErrorMessage } from '../utils/downloadExcel.js';
import { buildLaboratoriesPdfHtml, canSaveLaboratoriesPdf } from '../utils/laboratoriesPdf.js';
import { printHtmlDocument } from '../utils/pdfPrint.js';
import { useEffect, useState } from 'react';
import api, { logoutSession } from '../api';
import { useNavigate } from 'react-router-dom';
import './Laboratories.css';

// The API returns DATE columns as ISO timestamps (e.g. 2026-10-30T16:00:00.000Z, which is midnight in Manila).
// Always convert to a plain Manila calendar date; never display or slice the raw timestamp.
function dateOnly(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function statusLabel(lab) {
    if (lab.status_other) return lab.status_other;
    const text = String(lab.status || '').toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function Laboratories() {
    const { confirm, prompt, notify, undoToast, askNewOption, feedback } = useClmsDialog();
    // Success results use the same centered dark-green popup as the Delete popup (no separate white dialog).
    const success = text => feedback(text, 'success');
    const failure = text => feedback(text, 'error');
    const [labStatusOptions, setLabStatusOptions] = useState([]);
    const [labStatusIds, setLabStatusIds] = useState({}); // custom status value -> lookup_options id (only these are deletable)
    useEffect(() => { api.get('/options', { params: { category: 'laboratory_status' } }).then(r => { setLabStatusOptions((r.data.options || []).map(o => o.value)); setLabStatusIds(Object.fromEntries((r.data.options || []).map(o => [o.value, o.id]))); }).catch(() => {}); }, []);
    // Picking a saved custom status or a brand-new one stores status=OTHERS + the label (lab stays non-reservable, as before).
    async function handleStatusPick(picked) {
        let nextStatus = picked, nextOther = '';
        if (picked === '__OTHERS__') {
            const answer = await askNewOption('laboratory status', ['OPEN', 'USED', 'UNAVAILABLE', ...labStatusOptions]);
            if (!answer) return;
            const builtIn = ['OPEN', 'USED', 'UNAVAILABLE'].find(v => v.toLowerCase() === answer.value.toLowerCase());
            if (builtIn) { nextStatus = builtIn; }
            else {
                if (!answer.existing) {
                    try { const created = await api.post('/options', { category: 'laboratory_status', value: answer.value }); if (created.data?.option?.id) setLabStatusIds(cur => ({ ...cur, [answer.value]: created.data.option.id })); setLabStatusOptions(cur => [...new Set([...cur, answer.value])].sort((a, b) => a.localeCompare(b))); showMsg('Status saved to the dropdown', 'success'); }
                    catch (error) { showMsg(error.response?.data?.message || 'Unable to save the custom status', 'error'); return; }
                }
                nextStatus = 'OTHERS'; nextOther = answer.value;
            }
        } else if (picked.startsWith('custom:')) { nextStatus = 'OTHERS'; nextOther = picked.slice(7); }
        setStatus(nextStatus); setStatusOther(nextOther); setAvailableDateFrom(''); setAvailableDateUntil(''); setUnavailableFrom(''); setUnavailableUntil(''); setUsedFrom(''); setUsedUntil(''); setReason('');
    }
    async function deleteCustomStatus(value) {
        const id = labStatusIds[value];
        if (!id) return;
        if (!await confirm(`Delete the custom laboratory status “${value}” from the dropdown? Existing laboratories keep their value.`, { title: 'Delete custom option', confirmLabel: 'Delete', danger: true })) return;
        try {
            const response = await api.delete(`/options/${id}`);
            setLabStatusOptions(cur => cur.filter(item => item !== value));
            setLabStatusIds(cur => { const next = { ...cur }; delete next[value]; return next; });
            if (status === 'OTHERS' && statusOther === value) { setStatus('OPEN'); setStatusOther(''); }
            feedback(response.data.message || 'Custom status deleted.');
        } catch (error) { showMsg(error.response?.data?.message || 'Unable to delete the status. Nothing was changed.', 'error'); }
    }
    const [laboratories, setLaboratories] = useState([]);
    const [loadingLabs, setLoadingLabs] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [laboratoryName, setLaboratoryName] = useState('');
    const [capacity, setCapacity] = useState('');
    const [status, setStatus] = useState('OPEN');
    const [editingId, setEditingId] = useState(null);
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('success');
    useCenteredFeedback(message, messageType, () => setMessage(''));
    const [saving, setSaving] = useState(false);
    const [availableFrom, setAvailableFrom] = useState('');
    const [availableUntil, setAvailableUntil] = useState('');
    // CP174: booking interval in minutes. New laboratories start at the backend default (60); editing loads the saved value.
    const [bookingInterval, setBookingInterval] = useState('60');
    const [statusOther, setStatusOther] = useState('');
    const [availableDateFrom, setAvailableDateFrom] = useState('');
    const [availableDateUntil, setAvailableDateUntil] = useState('');
    const [unavailableFrom, setUnavailableFrom] = useState('');
    const [unavailableUntil, setUnavailableUntil] = useState('');
    const [usedFrom, setUsedFrom] = useState('');
    const [usedUntil, setUsedUntil] = useState('');
    const [reason, setReason] = useState('');
    const [editingSnapshot, setEditingSnapshot] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 5; // CP187: 5 rows per page; typed page number + Previous / Next
    const [selectedLabIds, setSelectedLabIds] = useState([]);

    const navigate = useNavigate();
    const user = JSON.parse(localStorage.getItem('user'));

    // Single loader used by the first load, Try Again, import and every reload after delete / save.
    async function loadLaboratories() {
        setLoadingLabs(true); // the error alert stays visible (button shows "Retrying…") until a load succeeds
        try {
            const response = await api.get('/laboratories');
            setLaboratories(response.data.laboratories); setLoadError('');
        } catch (error) {
            console.error('Unable to fetch laboratories:', error);
            setLoadError(error.response?.data?.message || 'Unable to load laboratories. Check your connection and permissions, then try again.');
        } finally { setLoadingLabs(false); }
    }

    useEffect(() => {
        // Initial load; state is set when the request resolves.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadLaboratories();
    }, []);

    function showMsg(text, type = 'success') {
        setMessage(text);
        setMessageType(type);
    }

    async function handleCreateLaboratory() {
        setSaving(true);
        try {
            const response = await api.post('/laboratories', {
                laboratory_name: laboratoryName,
                capacity,
                status,
                available_from: availableFrom,
                available_until: availableUntil,
                booking_interval: Number(bookingInterval),
                status_other: status === 'OTHERS' ? statusOther : null, available_date_from: availableDateFrom || null, available_date_until: availableDateUntil || null,
                unavailable_from: unavailableFrom || null, unavailable_until: unavailableUntil || null, used_from: usedFrom || null, used_until: usedUntil || null, reason
            });
            setLaboratories([...laboratories, response.data.laboratory]);
            setMessage('');
            const createdId = response.data.laboratory?.id;
            resetForm();
            setShowModal(false);
            // Genuine undo: removes the laboratory that was just created (the server refuses if it is already referenced).
            if (createdId) undoToast('Successfully added.', async () => {
                await api.delete(`/laboratories/${createdId}`);
                await loadLaboratories();
                return 'Laboratory addition undone.';
            }); else success('New laboratory has been created successfully.');
        } catch (error) {
            showMsg(error.response?.data?.message || 'Unable to create laboratory', 'error');
        } finally { setSaving(false); }
    }

    async function handleUpdateLaboratory() {
        setSaving(true);
        try {
            const response = await api.put(`/laboratories/${editingId}`, {
                laboratory_name: laboratoryName,
                capacity,
                status,
                available_from: availableFrom,
                available_until: availableUntil,
                booking_interval: Number(bookingInterval),
                status_other: status === 'OTHERS' ? statusOther : null, available_date_from: availableDateFrom || null, available_date_until: availableDateUntil || null,
                unavailable_from: unavailableFrom || null, unavailable_until: unavailableUntil || null, used_from: usedFrom || null, used_until: usedUntil || null, reason
            });
            setLaboratories(
                laboratories.map((lab) =>
                    Number(lab.id) === Number(editingId) ? response.data.laboratory : lab
                )
            );
            setMessage('');
            resetForm();
            setShowModal(false);
            const updateUndoId = response.data.undoActionId;
            // Genuine undo: the server restores the previous values only if the laboratory has not changed since.
            if (updateUndoId) undoToast('Successfully updated.', async () => {
                const undone = await api.post(`/undo/record/${updateUndoId}`);
                await loadLaboratories();
                return undone.data.message || 'Update undone.';
            }); else success('Laboratory updated successfully.');
        } catch (error) {
            showMsg(error.response?.data?.message || 'Unable to update laboratory', 'error');
        } finally { setSaving(false); }
    }

    // Deleting moves the laboratory to the Recycle Bin. The server refuses (with counts) while computers, equipment
    // or reservations still use it, so nothing is orphaned.
    async function handleDeleteLaboratory(id) {
        const confirmed = await confirm('Delete this laboratory? It is moved to the Recycle Bin and can be restored. A laboratory that is still used by computers, equipment or reservations cannot be deleted.', { title: 'Delete laboratory', confirmLabel: 'Delete', danger: true });
        if (!confirmed) return;

        try {
            const { data } = await api.delete(`/laboratories/${id}`);
            setMessage('');
            setSelectedLabIds(current => current.filter(item => item !== Number(id)));
            await loadLaboratories();
            undoToast(deletedMessage(data, 'Successfully deleted.'), async () => {
                const restored = await api.post('/recycle-bin/restore', { ids: data.recycleIds });
                await loadLaboratories();
                return restored.data.message || 'Laboratory restored.';
            }, { label: 'Restore', title: 'Deleted' });
        } catch (error) {
            setMessage('');
            await notify(error.response?.data?.message || 'Unable to delete laboratory. Nothing was deleted.', { title: 'Nothing deleted' });
        }
    }

    async function handleExportLaboratories() {
        // CP174 Part 4: export the listed laboratories (all pages of the current search), like Users export and Save as PDF.
        if (!visibleLaboratories.length) { await notify(laboratories.length ? 'No laboratories match the current search, so there is nothing to export.' : 'There are no laboratories to export.', { title: 'Nothing to export' }); return; }
        try {
            const name = await downloadExcel('/laboratories/export', { ids: visibleLaboratories.map(lab => lab.id) }, 'CLMS_Laboratories_Export.xlsx');
            success(`Exported ${visibleLaboratories.length} laboratory record(s) to ${name}.`);
        } catch (error) {
            await notify(await exportErrorMessage(error, 'Unable to export laboratories.'), { title: 'Export failed' });
        }
    }

    async function handleSubmitLaboratory(event) {
        event.preventDefault();
        if (!laboratoryName.trim()) { showMsg('Laboratory name is required', 'error'); return; }
        if (!Number.isInteger(Number(capacity)) || Number(capacity) < 1) { showMsg('Capacity must be a positive whole number', 'error'); return; }
        if (!/^\d+$/.test(String(bookingInterval).trim()) || !Number.isSafeInteger(Number(bookingInterval)) || Number(bookingInterval) < 1) { showMsg('Booking interval must be a positive whole number of minutes', 'error'); return; }
        if (status === 'OTHERS' && !statusOther.trim()) { showMsg('Enter the custom status for Others', 'error'); return; }
        if (status === 'OTHERS' && !reason.trim()) { showMsg('Enter the reason for the Others status', 'error'); return; }
        if ((availableFrom && !availableUntil) || (!availableFrom && availableUntil) || (availableFrom && availableUntil && availableFrom >= availableUntil)) { showMsg('Provide both valid opening and closing times, with closing later than opening', 'error'); return; }
        if (status === 'OPEN' && availableDateFrom && availableDateUntil && availableDateFrom > availableDateUntil) { showMsg('Available Until must be on or after Available From', 'error'); return; }
        if (status === 'UNAVAILABLE' && (!unavailableFrom || !unavailableUntil || !reason.trim())) { showMsg('Enter unavailable dates and the reason', 'error'); return; }
        if (status === 'USED' && usedFrom && usedUntil && usedFrom > usedUntil) { showMsg('Used Until must be on or after Used From', 'error'); return; }
        if (!await confirm(`${editingId === null ? 'Add' : 'Save changes to'} this laboratory${status === 'OTHERS' ? ` with the custom status "${statusOther.trim()}"` : ''}?`)) return;
        if (editingId === null) {
            handleCreateLaboratory();
        } else {
            handleUpdateLaboratory();
        }
    }

    function handleEditClick(lab) {
        setEditingId(lab.id);
        setLaboratoryName(lab.laboratory_name);
        setCapacity(lab.capacity);
        setEditingSnapshot(lab);
        setStatusOther(lab.status_other || '');
        setStatus(lab.status_other ? 'OTHERS' : lab.status);
        setAvailableFrom(lab.available_from ? lab.available_from.slice(0, 5) : '');
        setAvailableUntil(lab.available_until ? lab.available_until.slice(0, 5) : '');
        setBookingInterval(lab.booking_interval != null ? String(lab.booking_interval) : '');
        setAvailableDateFrom(dateOnly(lab.available_date_from));
        setAvailableDateUntil(dateOnly(lab.available_date_until));
        setUnavailableFrom(dateOnly(lab.unavailable_from));
        setUnavailableUntil(dateOnly(lab.unavailable_until));
        setUsedFrom(dateOnly(lab.used_from));
        setUsedUntil(dateOnly(lab.used_until));
        setReason(lab.reason || '');
        setShowModal(true);
    }

    function resetForm() {
        setEditingId(null);
        setLaboratoryName('');
        setCapacity('');
        setStatus('OPEN');
        setAvailableFrom('');
        setAvailableUntil('');
        setBookingInterval('60');
        setStatusOther('');
        setAvailableDateFrom(''); setAvailableDateUntil(''); setUnavailableFrom(''); setUnavailableUntil(''); setUsedFrom(''); setUsedUntil(''); setReason(''); setEditingSnapshot(null);
    }

    function handleCancelModal() {
        resetForm();
        setShowModal(false);
    }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    const labSearch = searchTerm.trim().toLowerCase();
    const visibleLaboratories = laboratories.filter(lab => !labSearch || [lab.laboratory_name, lab.capacity, lab.status, lab.status_other, dateOnly(lab.available_date_from), dateOnly(lab.available_date_until), dateOnly(lab.unavailable_from), dateOnly(lab.unavailable_until), dateOnly(lab.used_from), dateOnly(lab.used_until), lab.reason].some(value => String(value ?? '').toLowerCase().includes(labSearch)));
    const totalPages = Math.max(1, Math.ceil(visibleLaboratories.length / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const allLabsSelected = visibleLaboratories.length > 0 && visibleLaboratories.every(lab => selectedLabIds.includes(lab.id))
    const pageLaboratories = visibleLaboratories.slice((safePage - 1) * pageSize, safePage * pageSize);

    // Save as PDF: every laboratory matching the current search (all pages), US Letter with the PTC header.
    async function handleSaveLaboratoriesPdf() {
        try {
            await printHtmlDocument(buildLaboratoriesPdfHtml(visibleLaboratories, { search: searchTerm.trim(), logoBase: window.location.origin }));
        } catch {
            failure('Unable to prepare the PDF. Please try again.');
        }
    }

    // ---- Select All / Delete Selected / Clear Selection ----
    // Select All selects every laboratory that matches the current search (all pages), like the Computers page.
    function handleSelectAllLabs() { setSelectedLabIds(visibleLaboratories.map(lab => Number(lab.id))); }
    function handleClearSelection() { setSelectedLabIds([]); }
    function toggleLabSelected(id, checked) { setSelectedLabIds(current => checked ? [...new Set([...current, Number(id)])] : current.filter(item => item !== Number(id))); }
    // Same safe delete as the single Delete: records go to the Recycle Bin; any laboratory still used by computers,
    // equipment or reservations is skipped by the server and reported.
    async function handleDeleteAllLabs() {
        // Delete All = the selected laboratories, or every laboratory in the current (searched) list when nothing is selected.
        const ids = selectedLabIds.length ? selectedLabIds : visibleLaboratories.map(lab => Number(lab.id));
        if (!ids.length) { failure('There are no laboratories to delete.'); return; }
        const confirmed = await confirm(`Delete ${selectedLabIds.length ? `${ids.length} selected` : `all ${ids.length} listed`} laborator${ids.length === 1 ? 'y' : 'ies'}? They are moved to the Recycle Bin and can be restored. A laboratory that is still used by computers, equipment or reservations cannot be deleted.`, { title: 'Delete selected laboratories', confirmLabel: 'Delete', danger: true });
        if (!confirmed) return;
        try {
            const { data } = await api.post('/laboratories/bulk-delete', { ids });
            setMessage('');
            setSelectedLabIds([]);
            await loadLaboratories();
            undoToast(deletedMessage(data, 'Successfully deleted.'), async () => {
                const restored = await api.post('/recycle-bin/restore', { ids: data.recycleIds });
                await loadLaboratories();
                return restored.data.message || 'Laboratories restored.';
            }, { label: 'Restore', title: 'Deleted' });
        } catch (error) {
            setMessage('');
            failure(error.response?.data?.message || 'Unable to delete the laboratories. Nothing was deleted.');
        }
    }

    function statusClass(s) {
        if (s === 'OPEN') return 'open';
        if (s === 'USED') return 'used';
        return 'unavailable';
    }

    return (
        <div className="laboratories-page">

            {/* Background overlay */}
            <div className="dashboard-overlay"></div>


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
                        <span>MIS</span>
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
                        className="dashboard-button active"
                    >
                        <span className="button-icon"></span>
                        <span>Laboratories</span>
                    </button>

                    <button
                        type="button"
                        className="dashboard-button"
                        onClick={() => navigate('/computers')}
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

                <main className="laboratories-main">

                    {/* Title bar */}
                    <div className="page-title-bar labs-title-bar">
                        <h2>Laboratories</h2>
                    </div>

                    {/* CP130: Total Laboratories context box (same green translucent style as the dashboard context boxes) */}
                    <div className="labs-context-box compact-dashboard-card" aria-live="polite"><span>Total Laboratories</span><strong data-testid="labs-total">{laboratories.length}</strong></div>

                    {/* Alert */}
                    {loadError && <div className="alert-message" role="alert">{loadError} <button type="button" className="btn-primary" onClick={loadLaboratories} disabled={loadingLabs}>{loadingLabs ? 'Retrying…' : 'Try Again'}</button></div>}

                    {/* CP119: one toolbar row - Total Laboratories box, search, then the action buttons (wraps as whole items on narrow screens) */}
                    <div className="labs-toolbar" role="toolbar" aria-label="Laboratory tools">
                        <div className="labs-search-field"><label htmlFor="labs-search" className="sr-only">Search all laboratory fields</label><input id="labs-search" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1); setSelectedLabIds([]) }} placeholder="Search laboratory, capacity, status, dates, reason…" /></div>
                        <div className="labs-toolbar-actions">
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={() => {
                                    resetForm();
                                    setMessage('');
                                    setShowModal(true);
                                }}
                            >
                                + Add Laboratory
                            </button>
                            <FileActionsMenu module="laboratories" role={user?.role} pdf={canSaveLaboratoriesPdf(user?.role)} importProps={{ endpoint: "/laboratories", onImported: loadLaboratories, label: "laboratory", fixedLayout: true }} onExport={handleExportLaboratories} onPdf={handleSaveLaboratoriesPdf} />
                            {/* CP188: one toggle like the Reservations reference - Select All, then Clear Selection once every listed laboratory is selected */}
                            <button type="button" className="btn-primary" onClick={allLabsSelected ? handleClearSelection : handleSelectAllLabs} disabled={!visibleLaboratories.length}>{allLabsSelected ? 'Clear Selection' : 'Select All'}</button>
                            <button type="button" className="btn-delete" onClick={handleDeleteAllLabs} disabled={!visibleLaboratories.length && !selectedLabIds.length}>{selectedLabIds.length ? `Delete (${selectedLabIds.length})` : 'Delete All'}</button>
                        </div>
                    </div>
                    {/* Table */}
                    <div className="labs-table-wrapper">
                        <table className="labs-table">
                            <thead>
                                <tr>
                                    <th><input type="checkbox" aria-label="Select all laboratories on this page" checked={pageLaboratories.length > 0 && pageLaboratories.every(lab => selectedLabIds.includes(Number(lab.id)))} onChange={event => setSelectedLabIds(current => event.target.checked ? [...new Set([...current, ...pageLaboratories.map(lab => Number(lab.id))])] : current.filter(id => !pageLaboratories.some(lab => Number(lab.id) === id)))} /></th><th>Laboratory</th><th>Capacity</th><th>Status</th><th>Reason</th><th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pageLaboratories.length === 0 ? <tr><td colSpan={6} className="empty-state">{loadingLabs && laboratories.length === 0 ? 'Loading laboratories…' : loadError && laboratories.length === 0 ? 'Laboratories could not be loaded.' : 'No laboratories match this search.'}</td></tr> : pageLaboratories.map((lab) => (
                                    <tr key={lab.id}>
                                        <td><input type="checkbox" aria-label={`Select laboratory ${lab.laboratory_name}`} checked={selectedLabIds.includes(Number(lab.id))} onChange={event => toggleLabSelected(lab.id, event.target.checked)} /></td>
                                        <td>{lab.laboratory_name}</td>
                                        <td>{lab.capacity}</td>
                                        <td>
                                            <span className={`status-badge ${statusClass(lab.status)}`}>
                                                {statusLabel(lab)}
                                            </span>
                                        </td>
                                        <td>{lab.status_other ? (lab.reason || '—') : lab.status === 'UNAVAILABLE' ? `Unavailable from ${dateOnly(lab.unavailable_from) || '—'} until ${dateOnly(lab.unavailable_until) || '—'}${lab.reason ? ` — ${lab.reason}` : ''}` : lab.status === 'USED' ? `Used from ${dateOnly(lab.used_from) || '—'} until ${dateOnly(lab.used_until) || '—'}` : `Available from ${dateOnly(lab.available_date_from) || '—'} until ${dateOnly(lab.available_date_until) || '—'}`}</td>
                                        <td>
                                            <div className="table-actions">
                                                <button
                                                    type="button"
                                                    className="btn-edit"
                                                    onClick={() => handleEditClick(lab)}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    className="btn-delete"
                                                    onClick={() => handleDeleteLaboratory(lab.id)}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <PagePager className="labs-pagination" ariaLabel="Laboratory pagination" summary={`Showing ${visibleLaboratories.length ? (safePage - 1) * pageSize + 1 : 0}–${Math.min(safePage * pageSize, visibleLaboratories.length)} of ${visibleLaboratories.length}`} page={safePage} totalPages={totalPages} onPage={setCurrentPage} />
                </main>

            </div>

            {/* =========================================
                MODAL
            ========================================= */}

            {showModal && (
                <div className="modal-backdrop" onClick={handleCancelModal}>
                    <div
                        className="modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2>{editingId === null ? 'Add Laboratory' : 'Edit Laboratory'}</h2>

                        <form onSubmit={handleSubmitLaboratory}>

                            <div className="form-group">
                                <label>Laboratory Name</label>
                                <input
                                    type="text"
                                    value={laboratoryName}
                                    placeholder="Enter laboratory name"
                                    required
                                    maxLength={100}
                                    onChange={(e) => setLaboratoryName(e.target.value)}
                                />
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Capacity</label>
                                    <input
                                        type="number"
                                        value={capacity}
                                        min="1"
                                        placeholder="No. of Computers"
                                        onChange={(e) => setCapacity(e.target.value)}
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Status</label>
                                    <OptionSelect ariaLabel="Status" value={status === 'OTHERS' ? `custom:${statusOther}` : status} onChange={handleStatusPick} onOthers={() => handleStatusPick('__OTHERS__')} onDeleteCustom={option => deleteCustomStatus(option.value.slice(7))} options={[{ value: 'OPEN', label: 'OPEN' }, { value: 'USED', label: 'USED' }, { value: 'UNAVAILABLE', label: 'UNAVAILABLE' }, ...[...new Set([...labStatusOptions, ...(status === 'OTHERS' && statusOther ? [statusOther] : [])])].map(value => ({ value: `custom:${value}`, label: value, custom: Boolean(labStatusIds[value]), id: labStatusIds[value] }))]} />
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label htmlFor="lab-booking-interval">Booking Interval (minutes)</label>
                                    <input
                                        id="lab-booking-interval"
                                        type="number"
                                        inputMode="numeric"
                                        min="1"
                                        step="1"
                                        value={bookingInterval}
                                        placeholder="e.g. 60"
                                        onChange={(e) => setBookingInterval(e.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                            {status === 'OPEN' && <>
                                <div className="form-row"><div className="form-group"><label>Opening Time (optional)</label><input type="time" value={availableFrom} onChange={event => setAvailableFrom(event.target.value)} /></div><div className="form-group"><label>Closing Time (optional)</label><input type="time" value={availableUntil} onChange={event => setAvailableUntil(event.target.value)} /></div></div>
                                <div className="form-row"><div className="form-group"><label>Available From Date</label><DatePicker showHolidayList={false} allowClear title="Available From date" placeholder="Choose a date (optional)" value={availableDateFrom} onChange={setAvailableDateFrom} /></div><div className="form-group"><label>Available Until Date</label><DatePicker showHolidayList={false} allowClear title="Available Until date" placeholder="Choose a date (optional)" value={availableDateUntil} min={availableDateFrom || undefined} onChange={setAvailableDateUntil} /></div></div>
                            </>}
                            {status === 'UNAVAILABLE' && <><div className="form-row"><div className="form-group"><label>Unavailable From</label><DatePicker showHolidayList={false} required title="Unavailable From date" value={unavailableFrom} onChange={setUnavailableFrom} /></div><div className="form-group"><label>Unavailable Until</label><DatePicker showHolidayList={false} required title="Unavailable Until date" value={unavailableUntil} min={unavailableFrom || undefined} onChange={setUnavailableUntil} /></div></div><div className="form-group"><label>Reason</label><textarea required rows="3" maxLength={255} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why is this laboratory unavailable?" /></div></>}
                            {status === 'OTHERS' && <div className="form-group"><label>Reason</label><textarea required rows="3" maxLength={255} value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason for this status" /></div>}
                            {status === 'USED' && <div className="form-row"><div className="form-group"><label>Used From</label><DatePicker showHolidayList={false} allowClear title="Used From date" placeholder="Choose a date (optional)" value={usedFrom} onChange={setUsedFrom} /></div><div className="form-group"><label>Used Until</label><DatePicker showHolidayList={false} allowClear title="Used Until date" placeholder="Choose a date (optional)" value={usedUntil} min={usedFrom || undefined} onChange={setUsedUntil} /></div></div>}

                            <div className="modal-actions">
                                <button type="submit" className="btn-primary" disabled={saving}>
                                    {saving ? 'Saving…' : editingId === null ? 'Save' : 'Update'}
                                </button>
                                {editingId !== null && editingSnapshot && <button type="button" className="btn-secondary" onClick={() => handleEditClick(editingSnapshot)}>Undo Changes</button>}
                                <button type="button" className="btn-secondary" onClick={handleCancelModal}>Cancel</button>
                            </div>

                        </form>
                    </div>
                </div>
            )}

    

    

        </div>
    );
}

export default Laboratories;