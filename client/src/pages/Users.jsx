import { deletedMessage } from '../utils/deleteInfo.js'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx';
import { useEffect, useState } from 'react';
import FileActionsMenu from '../components/FileActionsMenu.jsx';
import { downloadExcel, exportErrorMessage } from '../utils/downloadExcel.js';
import { buildUsersPdfHtml, canSaveUsersPdf, userRoleLabel, userNameParts } from '../utils/usersPdf.js';
import { printHtmlDocument } from '../utils/pdfPrint.js';
import api, { logoutSession } from '../api';
import { useNavigate } from 'react-router-dom';
import './Users.css';
import { sortUsersByName } from '../utils/userSort.js';

// Surname / first name / MI come from saved columns; older accounts fall back to splitting full_name.
function nameParts(u) {
    if (u.surname || u.first_name) return { surname: u.surname || '', first: u.first_name || '', mi: u.middle_initial || '' }
    const tokens = String(u.full_name || '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length < 2) return { surname: tokens[0] || '', first: '', mi: '' }
    return { surname: tokens[tokens.length - 1], first: tokens.slice(0, -1).join(' '), mi: '' }
}

function Users() {
    const { confirm, prompt, notify, undoToast } = useClmsDialog();
    const [users, setUsers] = useState([]);
    const [showModal, setShowModal] = useState(false);
    const [editingUser, setEditingUser] = useState(null);

    const [surname, setSurname] = useState('');
    const [firstName, setFirstName] = useState('');
    const [middleInitial, setMiddleInitial] = useState('');
    const [roleOther, setRoleOther] = useState('');
    // CP140: custom roles already saved (GET /users/custom-roles, MIS only). They are offered in the Role dropdown.
    // A new role name is saved by the existing backend when the account is saved (POST/PUT /users registers it); there is no separate "create role" endpoint.
    const [customRoles, setCustomRoles] = useState([]);
    async function loadCustomRoles() {
        try { const response = await api.get('/users/custom-roles'); setCustomRoles(Array.isArray(response.data) ? response.data : []); }
        catch { /* the dropdown still works with the built-in roles; the server stays the authority on every role name */ }
    }
    // Mirrors the server's reserved names (userValidation.js); the server re-checks them on save.
    // CP141: delete an UNUSED saved custom role (user_count === 0) with the existing DELETE /users/custom-roles/:ref.
    // The server re-checks inside a transaction, so a role assigned in the meantime is refused with HTTP 409; the list is then reloaded.
    const [deletingRoleId, setDeletingRoleId] = useState(null);
    async function deleteSavedCustomRole(item) {
        if (!item || Number(item.user_count) !== 0 || deletingRoleId !== null) return;
        if (!await confirm(`Delete the custom role \u201c${item.role_name}\u201d? It is not assigned to any account. This cannot be undone.`, { title: 'Delete custom role', confirmLabel: 'Delete', danger: true })) return;
        setDeletingRoleId(item.id);
        try {
            const { data } = await api.delete(`/users/custom-roles/${encodeURIComponent(item.id)}`);
            if (role === 'Others' && sameName(roleOther, item.role_name)) { setRole(''); setRoleOther(''); }
            await loadCustomRoles();
            await notify(data?.message || `Custom role \u201c${item.role_name}\u201d deleted.`, { title: 'Custom role deleted' });
        } catch (error) {
            const status = error.response?.status;
            await loadCustomRoles(); // show the true state (a 409 means the role is now assigned, so Delete disappears)
            const reason = status === 409 ? 'This custom role is now assigned to an account and was not deleted.'
                : status === 404 ? 'This custom role no longer exists.'
                : status === 403 ? 'This role cannot be deleted.'
                : 'Unable to delete the custom role. Nothing was deleted.';
            await notify(status && status < 500 && error.response?.data?.message ? error.response.data.message : reason, { title: 'Nothing deleted' });
        } finally { setDeletingRoleId(null); }
    }

    // CP166: Teacher program "Others" opens a popup for the program name (like the custom role popup). Resolves with the program value
    // ({ program: 'BSIT' | 'BSOA' | 'Others', other }) or null when cancelled. Typing BSIT/BSOA reuses the built-in program.
    async function askProgramName(current = '') {
        let text = 'Enter the program name:';
        for (;;) {
            const typed = await prompt(text, { title: 'Program', placeholder: 'e.g. BSCS', confirmLabel: 'Use this program' });
            if (typed === null || typed === undefined) return null;
            const name = String(typed).trim().replace(/\s+/g, ' ');
            if (!name) { text = 'The program name cannot be empty. Enter the program name:'; continue; }
            if (name.length > 100) { text = 'The program name must be 100 characters or fewer. Enter a shorter name:'; continue; }
            if (name.toLocaleLowerCase() === 'others') { text = 'Enter the actual program name instead of the word \u201cOthers\u201d:'; continue; }
            const builtIn = ['BSIT', 'BSOA'].find(item => item.toLocaleLowerCase() === name.toLocaleLowerCase());
            return builtIn ? { program: builtIn, other: '' } : { program: 'Others', other: name };
        }
    }

    const RESERVED_ROLE_NAMES = ['mis', 'super admin', 'mis head', 'mis staff', 'inventory staff', 'dean', 'teacher', 'others', 'custom'];
    const cleanRoleName = value => String(value ?? '').trim().replace(/\s+/g, ' ');
    const sameName = (a, b) => cleanRoleName(a).toLocaleLowerCase() === cleanRoleName(b).toLocaleLowerCase();
    // Popup for the custom role name. Re-asks (inside the popup) for an empty, too long, built-in or already existing name.
    // Resolves with the clean name, or null when cancelled. `current` is the name already chosen on this form (keeping it is allowed).
    async function askCustomRoleName(current = '') {
        let text = 'Enter the custom role name:';
        for (;;) {
            const typed = await prompt(text, { title: 'Custom role', placeholder: 'e.g. Librarian', confirmLabel: 'Use this role' });
            if (typed === null || typed === undefined) return null;
            const name = cleanRoleName(typed);
            if (!name) { text = 'The custom role name cannot be empty. Enter the custom role name:'; continue; }
            if (name.length > 100) { text = 'The custom role name must be 100 characters or fewer. Enter a shorter name:'; continue; }
            if (RESERVED_ROLE_NAMES.includes(name.toLocaleLowerCase())) { text = `\u201c${name}\u201d is a built-in role name. Enter a different custom role name:`; continue; }
            if (current && sameName(name, current)) return cleanRoleName(current);
            const existing = customRoles.find(item => sameName(item.role_name, name));
            if (existing) { text = `The custom role \u201c${existing.role_name}\u201d already exists. Choose it from the Role list, or enter a different name:`; continue; }
            return name;
        }
    }
    const [program, setProgram] = useState('');
    const [programOther, setProgramOther] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [selectedUserIds, setSelectedUserIds] = useState([]);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 5; // CP166 Part 5: default (and only) page size is 5 rows
    const [roleFilter, setRoleFilter] = useState('');
    const [pageText, setPageText] = useState('1');
    const search = searchTerm.trim().toLocaleLowerCase();
    const roleKey = u => u.role === 'Others' ? `custom:${String(u.role_other || '').trim().toLocaleLowerCase()}` : u.role;
    const sortedUsers = sortUsersByName(users); // CP107: always A-Z by displayed name, whatever order the server returned
    const visibleUsers = sortedUsers.filter(u => (!roleFilter || roleKey(u) === roleFilter) && (!search || [u.full_name, u.surname, u.first_name, u.username, u.role, u.role_other, u.program, u.status, u.role === 'MIS' ? 'Super Admin' : '', u.role === 'Teacher' && u.program ? `${u.program}-Teacher` : '', u.role === 'Inventory Staff' ? 'MIS Staff' : ''].some(value => String(value || '').toLocaleLowerCase().includes(search))));
    const totalPages = Math.max(1, Math.ceil(visibleUsers.length / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const pageUsers = visibleUsers.slice((safePage - 1) * pageSize, safePage * pageSize);
    useEffect(() => { setPageText(String(safePage)); }, [safePage]);
    function commitPageText() {
        const n = Number.parseInt(pageText, 10);
        if (!Number.isFinite(n) || n < 1) { setPageText(String(safePage)); return; }
        const target = Math.min(totalPages, n); setCurrentPage(target); setPageText(String(target));
    }
    // Role filter options: built-in roles plus every custom role (saved or in use), de-duplicated case-insensitively.
    const roleFilterOptions = (() => {
        const options = [{ value: 'MIS', label: userRoleLabel({ role: 'MIS' }) }, { value: 'Inventory Staff', label: 'MIS Staff' }, { value: 'Dean', label: 'Dean' }, { value: 'Teacher', label: 'Teacher' }];
        const seen = new Set();
        [...customRoles.map(item => item.role_name), ...users.filter(u => u.role === 'Others').map(u => u.role_other)].forEach(name => {
            const clean = String(name || '').trim(); const key = clean.toLocaleLowerCase();
            if (clean && !seen.has(key)) { seen.add(key); options.push({ value: `custom:${key}`, label: clean }); }
        });
        return options;
    })();

    const [message, setMessage] = useState('');
    useCenteredFeedback(message, '', () => setMessage(''));
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [loadError, setLoadError] = useState('');

    const navigate = useNavigate();
    const user = JSON.parse(localStorage.getItem('user'));

    async function getUsers() {
        setLoadingUsers(true); setLoadError('');
        try {
            const response = await api.get('/users');
            setUsers(Array.isArray(response.data.users) ? response.data.users : []); setCurrentPage(1);
        } catch (error) {
            const detail = error.response?.data?.message || 'Unable to load user accounts. Check your connection and permissions.';
            setLoadError(detail);
        } finally { setLoadingUsers(false); }
    }

    useEffect(() => {
        // This effect intentionally starts an API fetch; state updates occur when the request resolves.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        getUsers();
        loadCustomRoles();
    }, []);

    function openAddModal() {
        setEditingUser(null);
        setSurname(''); setFirstName(''); setMiddleInitial(''); setRoleOther('');
        setUsername('');
        setPassword('');
        setRole('');
        setProgram(''); setProgramOther('');
        setShowPassword(false);
        setMessage('');
        setShowModal(true);
    }

    function openEditModal(u) {
        setEditingUser(u);
        const parts = nameParts(u);
        setSurname(parts.surname); setFirstName(parts.first); setMiddleInitial(parts.mi);
        setUsername(u.username);
        setPassword('');
        setRoleOther(u.role_other || '');
        setRole(u.role_other ? 'Others' : u.role);
        { const custom = u.program && !['BSIT', 'BSOA'].includes(u.program); setProgram(custom ? 'Others' : (u.program || '')); setProgramOther(custom ? u.program : ''); }
        setShowPassword(false);
        setMessage('');
        setShowModal(true);
    }

    function closeModal() {
        setShowModal(false);
        setEditingUser(null);
        setSurname(''); setFirstName(''); setMiddleInitial(''); setRoleOther('');
        setUsername('');
        setPassword('');
        setRole('');
        setProgram(''); setProgramOther('');
        setShowPassword(false);
    }

    async function handleSubmit(event) {
        event.preventDefault();

        if (!surname.trim() || !firstName.trim() || !username || !role) {
            setMessage('Please complete the required fields');
            return;
        }
        if (role === 'Teacher' && !program) {
            setMessage('Select a Program (BSIT, BSOA or Others) for teacher accounts.');
            return;
        }
        if (role === 'Teacher' && program === 'Others' && !programOther.trim()) {
            setMessage('Enter the custom program name for Others.');
            return;
        }
        if (role === 'Others' && !roleOther.trim()) {
            setMessage('Enter the custom role name.');
            return;
        }

        if (!editingUser && !password) {
            setMessage('Password is required');
            return;
        }

        if (!await confirm(`${editingUser ? 'Save changes to' : 'Create'} this user account${role === 'Others' ? ` with the custom role "${roleOther.trim()}"` : ''}?`)) return;
        try {
            if (editingUser) {
                const response = await api.put(
                    `/users/${editingUser.id}`,
                    {
                        surname: surname, first_name: firstName, middle_initial: middleInitial,
                        role_other: role === 'Others' ? roleOther : null,
                        username: username,
                        role: role,
                        program: role === 'Teacher' ? program : null,
                        program_other: role === 'Teacher' && program === 'Others' ? programOther : null
                    }
                );
                setMessage('');
                const editUndoId = response.data.undoActionId;
                // Genuine undo: the server restores the previous values only if the account has not changed since.
                if (editUndoId) undoToast('Successfully updated.', async () => {
                    const undone = await api.post(`/undo/record/${editUndoId}`);
                    await getUsers();
                    return undone.data.message || 'Update undone.';
                }); else await notify(response.data.message || 'Successfully updated.', { title: 'Successfully updated' });
            } else {
                const response = await api.post(
                    '/users',
                    {
                        surname: surname, first_name: firstName, middle_initial: middleInitial,
                        role_other: role === 'Others' ? roleOther : null,
                        username: username,
                        password: password,
                        role: role,
                        program: role === 'Teacher' ? program : null,
                        program_other: role === 'Teacher' && program === 'Others' ? programOther : null
                    }
                );
                setMessage('');
                const createdUserId = response.data.user?.id;
                // Genuine undo: deletes the account that was just created (refused by the server if it is already in use).
                if (createdUserId !== undefined) undoToast('Successfully added.', async () => {
                    const undone = await api.delete(`/users/${createdUserId}`);
                    await getUsers();
                    return undone.data.message || 'User addition undone.';
                }); else await notify(response.data.message || 'Successfully added.', { title: 'Successfully added' });
            }

            await getUsers();
            await loadCustomRoles(); // a role name saved with this account is now in the Role list
            closeModal();
        } catch (error) {
            setMessage(
                error.response?.data?.message || 'Unable to save user'
            );
        }
    }

    // Deleting moves accounts to the MIS-only Recycle Bin. Accounts that are in use (reservation history, maintenance
    // reports, MIS accounts, your own account) are refused by the server with a reason - never silently deleted.
    async function deleteUsers(ids, description) {
        if (!await confirm(`Delete ${description}? They are moved to the Recycle Bin and can be restored. Accounts that are still in use cannot be deleted.`, { title: 'Delete users', confirmLabel: 'Delete', danger: true })) return;
        try {
            const { data } = await api.post('/users/bulk-delete', { ids });
            setSelectedUserIds([]);
            setMessage('');
            await getUsers();
            undoToast(deletedMessage(data, 'Successfully deleted.'), async () => {
                const restored = await api.post('/recycle-bin/restore', { ids: data.recycleIds });
                await getUsers();
                return restored.data.message || 'Users restored.';
            }, { label: 'Restore', title: 'Deleted' });
        } catch (error) {
            setMessage('');
            await notify(error.response?.data?.message || 'Unable to delete users. Nothing was deleted.', { title: 'Nothing deleted' });
        }
    }

    function handleDelete(u) {
        return deleteUsers([u.id], `the account of ${u.full_name}`);
    }

    const selectableIds = visibleUsers.filter(u => u.role !== 'MIS').map(u => u.id);
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedUserIds.includes(id));
    function selectAllUsers() { setSelectedUserIds(selectableIds); }
    function toggleSelectAllUsers() { setSelectedUserIds(allSelected ? [] : selectableIds); }
    // UI-only: unticks every selected account. Never deletes, edits or deactivates anything (no confirmation needed).
    function clearSelection() { setSelectedUserIds([]); }
    function toggleUser(id) { setSelectedUserIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]); }
    function handleDeleteSelected() { return deleteUsers(selectedUserIds, `${selectedUserIds.length} selected user account${selectedUserIds.length === 1 ? '' : 's'}`); }
    function handleDeleteAll() {
        if (!selectableIds.length) { notify('There are no user accounts to delete.', { title: 'Nothing to delete' }); return Promise.resolve(); }
        return deleteUsers(selectableIds, `all ${selectableIds.length} listed user account${selectableIds.length === 1 ? '' : 's'}`);
    }

    async function handleExport() {
        if (!visibleUsers.length) { await notify('There are no users to export.', { title: 'Nothing to export' }); return; }
        try {
            const name = await downloadExcel('/users/export', { ids: visibleUsers.map(u => u.id) }, 'CLMS_Users_Export.xlsx');
            await notify(`Exported ${visibleUsers.length} user record(s) to ${name}. Passwords are never included.`, { title: 'Export complete' });
        } catch (error) {
            await notify(await exportErrorMessage(error, 'Unable to export users.'), { title: 'Export failed' });
        }
    }

    // Save as PDF (Super Admin only): every user matching the current search (all pages), US Letter with the PTC header.
    async function handleSavePdf() {
        try {
            await printHtmlDocument(buildUsersPdfHtml(visibleUsers, { search: searchTerm.trim(), logoBase: window.location.origin }));
        } catch {
            await notify('Unable to prepare the PDF. Please try again.', { title: 'PDF failed' });
        }
    }

    async function handleStatus(u) {
        const nextStatus = u.status === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE'
        if (!await confirm(`${nextStatus === 'ACTIVE' ? 'Activate' : 'Deactivate'} ${u.full_name}?`)) return
        try {
            const response = await api.put(`/users/${u.id}/status`, { status: nextStatus, changed_by: user?.id })
            setMessage(response.data.message)
            await getUsers()
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to update account status') }
    }

    async function handleResetPassword(u) {
        const newPassword = await prompt(`Enter a new password for ${u.full_name}:`, { title: 'Reset password', inputType: 'password', placeholder: 'New password', confirmLabel: 'Reset password' })
        if (!newPassword) return
        if (!await confirm(`Reset the password for ${u.full_name}? They will be required to change it at next login.`, { title: 'Reset password', confirmLabel: 'Reset', danger: true })) return
        try {
            const response = await api.put(`/users/${u.id}/reset-password`, { new_password: newPassword, reset_by: user?.id })
            setMessage(response.data.message)
        } catch (error) { setMessage(error.response?.data?.message || 'Unable to reset password') }
    }

    async function handleLogout() {
        await logoutSession()
        navigate('/')
    }

    return (
        <div className="users-page">

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
                        G
                    </div>
                    <div className="user-info-header">
                        <strong>{user?.full_name || 'MIS Staff'}</strong>
                        <span>MIS</span>
                    </div>
                </div>

            </header>


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
                        className="dashboard-button active"
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
                        <span className="button-icon"></span><span>Assets & Equipment</span>
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

                <main className="users-main">

                    {/* Title bar */}
                    <div className="page-title-bar">
                        <h2>User Management</h2>
                    </div>

                                        {loadError && <div className="alert-message" role="alert">{loadError} <button type="button" onClick={getUsers}>Try Again</button></div>}
                    {/* Alert */}

                    {/* Search filters the actual loaded user records before rendering. */}
                    <div className="users-search-toolbar">
                        <label htmlFor="users-search">Search users</label>
                        <input id="users-search" type="search" value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setCurrentPage(1) }} placeholder="Search name, ID number, role, status, or program" autoComplete="off" />
                        <label htmlFor="users-role-filter" className="users-role-filter-label">Role</label>
                        <select id="users-role-filter" className="users-role-filter" value={roleFilter} onChange={event => { setRoleFilter(event.target.value); setCurrentPage(1); setSelectedUserIds([]) }} aria-label="Filter by role">
                            <option value="">All Roles</option>
                            {roleFilterOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        <span>{visibleUsers.length} of {users.length} users</span>
                        <div className="toolbar-inline-actions title-actions">
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={openAddModal}
                            >
                                Add User
                            </button>
                            <FileActionsMenu module="users" role={user?.role} pdf={canSaveUsersPdf(user?.role)} importProps={{ endpoint: "/users", onImported: getUsers, label: "user" }} onExport={handleExport} onPdf={handleSavePdf} />
                            {/* CP166 Part 3: one toggle like Reservations - "Select All" selects every listed (selectable) account, "Clear Selection" appears once all are selected and unticks them. UI-only. */}
                            <button type="button" className="users-selection-toggle" onClick={allSelected ? clearSelection : selectAllUsers} disabled={!selectableIds.length}>{allSelected ? 'Clear Selection' : 'Select All'}</button>
                            {selectedUserIds.length > 0 && <button type="button" className="btn-delete clms-delete-all" onClick={handleDeleteSelected}>Delete selected ({selectedUserIds.length})</button>}
                            <button type="button" className="btn-delete clms-delete-all" onClick={handleDeleteAll} disabled={!selectableIds.length}>Delete All</button>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="users-table-wrapper">
                        <div className="users-table-scroll">
                        <table className="users-table">
                            <thead>
                                <tr>
                                    <th className="no-print"><input type="checkbox" aria-label="Select all listed users" checked={allSelected} onChange={toggleSelectAllUsers} /></th>
                                    <th>ID Number</th>
                                    <th>Surname</th>
                                    <th>First Name</th>
                                    <th>MI</th>
                                    <th>Program</th>
                                    <th>Role</th><th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loadingUsers ? <tr><td colSpan={9}>Loading user accounts…</td></tr> : loadError ? <tr><td colSpan={9}>User accounts could not be loaded.</td></tr> : pageUsers.length === 0 ? <tr><td colSpan={9}>No users match your search.</td></tr> : pageUsers.map((u) => (
                                    <tr key={u.id}>
                                        <td className="no-print"><input type="checkbox" aria-label={`Select ${u.full_name}`} disabled={u.role === 'MIS'} checked={selectedUserIds.includes(u.id)} onChange={() => toggleUser(u.id)} /></td>
                                        <td>{u.username}</td>
                                        <td>{userNameParts(u).surname}</td>
                                        <td>{userNameParts(u).first || '—'}</td>
                                        <td>{userNameParts(u).mi || '—'}</td>
                                        <td>{u.program || '—'}</td>
                                        <td>{userRoleLabel(u)}</td>
                                        <td><span className={`user-status ${u.status === 'INACTIVE' ? 'inactive' : 'active'}`}>{u.status || 'ACTIVE'}</span></td>
                                        <td>
                                            {u.role !== 'MIS' && (
                                                <div className="table-actions">
                                                    <button type="button" className="btn-edit" onClick={() => openEditModal(u)}>Edit</button>
                                                    <button type="button" className="btn-edit" onClick={() => handleResetPassword(u)}>Reset Password</button>
                                                    <button type="button" className="btn-edit" onClick={() => handleStatus(u)}>{u.status === 'INACTIVE' ? 'Activate' : 'Deactivate'}</button>
                                                    <button type="button" className="btn-delete" onClick={() => handleDelete(u)}>Delete</button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        </div>
                    </div>
                    <div className="users-pagination no-print">
                        <span>Showing {visibleUsers.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, visibleUsers.length)} of {visibleUsers.length} users</span>
                        <button type="button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safePage <= 1}>Previous</button>
                        <label className="users-page-jump">Page <input type="text" inputMode="numeric" pattern="[0-9]*" className="users-page-input" aria-label="Page number" value={pageText} onChange={event => setPageText(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))} onBlur={commitPageText} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPageText(); } }} /> of {totalPages}</label>
                        <button type="button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safePage >= totalPages}>Next</button>
                    </div>

                </main>

            </div>


            {showModal && (
                <div className="modal-backdrop" onClick={closeModal}>
                    <div
                        className="modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2>{editingUser ? 'Edit User' : 'Add User'}</h2>

                        <form onSubmit={handleSubmit}>

                            <div className="form-group">
                                <label>Surname</label>
                                <input type="text" value={surname} placeholder="Enter surname" onChange={(e) => setSurname(e.target.value)} />
                            </div>
                            <div className="form-group">
                                <label>First Name</label>
                                <input type="text" value={firstName} placeholder="Enter first name" onChange={(e) => setFirstName(e.target.value)} />
                            </div>
                            <div className="form-group">
                                <label>MI</label>
                                <input type="text" value={middleInitial} maxLength={3} placeholder="Middle initial (optional)" onChange={(e) => setMiddleInitial(e.target.value)} />
                            </div>

                            <div className="form-group">
                                <label>ID Number</label>
                                <input
                                    type="text"
                                    value={username}
                                    placeholder="Enter ID number"
                                    onChange={(e) => setUsername(e.target.value)}
                                />
                            </div>

                            {!editingUser && (
                                <div className="form-group">
                                    <label>Password</label>
                                    <div className="password-field">
                                        <input
                                            type={showPassword ? 'text' : 'password'}
                                            value={password}
                                            placeholder="Enter password"
                                            autoComplete="new-password"
                                            onChange={(e) => setPassword(e.target.value)}
                                        />
                                        <button type="button" className="password-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} title={showPassword ? 'Hide password' : 'Show password'}>
                                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
                                                <circle cx="12" cy="12" r="3" />
                                                {showPassword && <line x1="3" y1="3" x2="21" y2="21" />}
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="form-group">
                                <label>Role</label>
                                <select
                                    value={role === 'Others' ? `custom:${(customRoles.find(item => sameName(item.role_name, roleOther))?.role_name) || cleanRoleName(roleOther)}` : role}
                                    onChange={async (e) => {
                                        const picked = e.target.value;
                                        if (picked === 'Others') {
                                            // Others opens a popup for the new custom role name; cancelling keeps the previous role.
                                            const name = await askCustomRoleName(role === 'Others' ? roleOther : '');
                                            if (!name) return;
                                            setRoleOther(name); setRole('Others');
                                            return;
                                        }
                                        if (picked.startsWith('custom:')) { setRoleOther(picked.slice(7)); setRole('Others'); return; }
                                        setRole(picked);
                                    }}
                                >
                                    <option value="">Choose a role</option>
                                    <option value="Dean">Dean</option>
                                    <option value="Teacher">Teacher</option>
                                    <option value="Inventory Staff">MIS Staff</option>
                                    {customRoles.map(item => <option key={item.id} value={`custom:${item.role_name}`}>{item.role_name}</option>)}
                                    {role === 'Others' && cleanRoleName(roleOther) && !customRoles.some(item => sameName(item.role_name, roleOther)) && <option value={`custom:${cleanRoleName(roleOther)}`}>{cleanRoleName(roleOther)}</option>}
                                    <option value="Others">Others</option>
                                </select>
                                {role === 'Others' && <small className="user-others-value">Custom role: <strong>{roleOther}</strong> <button type="button" className="btn-edit" onClick={async () => { const name = await askCustomRoleName(roleOther); if (name) setRoleOther(name); }}>Change</button><br />{customRoles.some(item => sameName(item.role_name, roleOther)) ? 'This role is already saved.' : 'The new role is saved when the account is saved, then appears in the Role list.'} The account is created as Active. Custom roles have no Teacher, Dean, MIS Staff or MIS Head permissions by default, but can use the reservation features currently permitted to Others.</small>}
                                {customRoles.some(item => Number(item.user_count) === 0) && <div className="custom-role-unused" data-testid="unused-custom-roles"><small>Unused custom roles (not assigned to any account):</small>{customRoles.filter(item => Number(item.user_count) === 0).map(item => <div key={item.id} className="custom-role-unused-row"><span>{item.role_name}</span> <button type="button" className="btn-delete" disabled={deletingRoleId !== null} aria-label={`Delete custom role ${item.role_name}`} onClick={() => deleteSavedCustomRole(item)}>Delete</button></div>)}</div>}
                                                            </div>
                                {role === 'Teacher' && <div className="form-group">
                                    <label>Program</label>
                                    <select
                                        value={program === 'Others' && programOther.trim() ? `custom:${programOther.trim()}` : program}
                                        onChange={async (e) => {
                                            const picked = e.target.value;
                                            if (picked === 'Others') {
                                                // Others opens a popup for the program name; cancelling keeps the previous program.
                                                const chosen = await askProgramName(program === 'Others' ? programOther : '');
                                                if (!chosen) return;
                                                setProgram(chosen.program); setProgramOther(chosen.other);
                                                return;
                                            }
                                            if (picked.startsWith('custom:')) return;
                                            setProgram(picked); setProgramOther('');
                                        }}
                                        required
                                    >
                                        <option value="">Select a program</option>
                                        <option value="BSIT">BSIT</option>
                                        <option value="BSOA">BSOA</option>
                                        {program === 'Others' && programOther.trim() && <option value={`custom:${programOther.trim()}`}>{programOther.trim()}</option>}
                                        <option value="Others">Others</option>
                                    </select>
                                    {program === 'Others' && programOther.trim() && <small className="user-others-value">Program: <strong>{programOther.trim()}</strong> <button type="button" className="btn-edit" onClick={async () => { const chosen = await askProgramName(programOther); if (chosen) { setProgram(chosen.program); setProgramOther(chosen.other); } }}>Change</button></small>}
                                </div>}


                            <div className="modal-actions">
                                <button type="submit" className="btn-primary">
                                    {editingUser ? 'Save Changes' : 'Add User'}
                                </button>
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={closeModal}
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

export default Users;