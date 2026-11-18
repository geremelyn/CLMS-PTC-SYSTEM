import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import { useClmsDialog, useCenteredFeedback } from '../components/ClmsDialog.jsx'
import MISPageShell from '../components/MISPageShell'
import { equipmentTypesForLaboratory, equipmentForType, equipmentOptionLabel, isValidEquipmentSelection } from '../utils/reportIssueEquipment.mjs'
import './ReportIssue.css'

function ReportIssue() {
    const navigate = useNavigate()
    const user = JSON.parse(localStorage.getItem('user') || 'null')
    const isTeacher = user?.role === 'Teacher'
    const isDean = user?.role === 'Dean'
    const isCustomRole = user?.role === 'Others' // CP85: custom roles may report issues (their own reports only)

    const [laboratories, setLaboratories] = useState([])
    const [computers, setComputers] = useState([])
    const [equipment, setEquipment] = useState([])
    const [laboratoryId, setLaboratoryId] = useState('')
    const presetType = (() => { const t = new URLSearchParams(window.location.search).get('type'); return t === 'computer' ? 'COMPUTER' : t === 'equipment' ? 'EQUIPMENT' : '' })()
    const [assetType, setAssetType] = useState(presetType)   // CP148: preselected from the Reports > Report Issue menu
    const [computerId, setComputerId] = useState('')
    const [equipmentType, setEquipmentType] = useState('')
    const [equipmentId, setEquipmentId] = useState('')
    const [issueDescription, setIssueDescription] = useState('')
    const [message, setMessage] = useState('')
    const [messageType, setMessageType] = useState('')
    const { confirm } = useClmsDialog()
    useCenteredFeedback(message, messageType, () => setMessage(''))
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [loadingAssets, setLoadingAssets] = useState(false)

    useEffect(() => {
        if (!isTeacher && !isDean && !isCustomRole) {
            navigate('/')
            return
        }
        async function load() {
            setLoadingAssets(true)
            try {
                const [labsResponse, computersResponse, equipmentResponse] = await Promise.all([
                    api.get('/laboratories'),
                    api.get('/computers'),
                    api.get('/equipment')
                ])
                setLaboratories(labsResponse.data.laboratories || [])
                setComputers(computersResponse.data.computers || [])
                setEquipment(equipmentResponse.data.equipment || [])
            } catch (error) {
                setMessage(error.response?.data?.message || 'Unable to load laboratories and assets.')
                setMessageType('error')
            } finally {
                setLoadingAssets(false)
            }
        }
        load()
    }, [isTeacher, isDean, isCustomRole, navigate])

    function showMessage(text, type = 'error') {
        setMessage(text)
        setMessageType(type)
    }

    function resetForm() {
        setLaboratoryId('')
        setAssetType('')
        setComputerId('')
        setEquipmentType('')
        setEquipmentId('')
        setIssueDescription('')
    }

    async function handleSubmit(event) {
        event.preventDefault()
        if (!laboratoryId) return showMessage('Please select a laboratory.')
        if (!assetType) return showMessage('Please select an asset type.')
        if (assetType === 'COMPUTER' && !computerId) return showMessage('Please select a computer.')
        if (assetType === 'EQUIPMENT' && !equipmentType) return showMessage('Please select an equipment type.')
        if (assetType === 'EQUIPMENT' && !equipmentId) return showMessage('Please select the specific equipment.')
        if (assetType === 'EQUIPMENT' && !isValidEquipmentSelection(equipment, laboratoryId, equipmentType, equipmentId)) return showMessage('Please select a valid equipment record for the chosen type.')
        if (!issueDescription.trim()) return showMessage('Please enter the issue description.')

        if (!await confirm('Submit this maintenance report?', { title: 'Submit report', confirmLabel: 'Submit' })) return
        setIsSubmitting(true)
        try {
            const response = await api.post('/maintenance', {
                laboratory_id: laboratoryId,
                computer_id: assetType === 'COMPUTER' ? computerId : null,
                equipment_id: assetType === 'EQUIPMENT' ? equipmentId : null,
                equipment_type: assetType === 'EQUIPMENT' ? equipmentType : null,
                issue_description: issueDescription.trim()
            })
            showMessage(response.data.message || 'Maintenance report submitted successfully.', 'success')
            resetForm()
        } catch (error) {
            showMessage(error.response?.data?.message || 'Unable to submit maintenance report.')
        } finally {
            setIsSubmitting(false)
        }
    }

    const filteredComputers = useMemo(() => computers.filter(
        computer => Number(computer.laboratory_id) === Number(laboratoryId)
    ), [computers, laboratoryId])

    const equipmentTypes = useMemo(() => equipmentTypesForLaboratory(equipment, laboratoryId), [equipment, laboratoryId])
    const filteredEquipment = useMemo(() => equipmentForType(equipment, laboratoryId, equipmentType), [equipment, laboratoryId, equipmentType])

    if (!isTeacher && !isDean && !isCustomRole) return null

    return (
        <MISPageShell active="report">
            <section className="report-issue-heading">
                <h1 className="clms-page-title">Report Issue</h1>
            </section>

            <section className="report-issue-card">
                <div className="report-issue-card-title">
                    <div><h3>Report an Issue</h3></div>
                </div>

                <form className="report-issue-form" onSubmit={handleSubmit}>
                    <div className="report-issue-form-grid">
                        <div className="report-issue-field">
                            <label htmlFor="report-laboratory">Laboratory</label>
                            <select id="report-laboratory" value={laboratoryId} onChange={event => { setLaboratoryId(event.target.value); setAssetType(presetType); setComputerId(''); setEquipmentType(''); setEquipmentId('') }} disabled={loadingAssets}>
                                <option value="">Select Laboratory</option>
                                {laboratories.map(laboratory => <option key={laboratory.id} value={laboratory.id}>{laboratory.laboratory_name}</option>)}
                            </select>
                        </div>

                        <div className="report-issue-field">
                            <label htmlFor="report-asset-type">Asset Type</label>
                            <select id="report-asset-type" value={assetType} onChange={event => { setAssetType(event.target.value); setComputerId(''); setEquipmentType(''); setEquipmentId('') }} disabled={!laboratoryId || loadingAssets}>
                                <option value="">Select Asset Type</option>
                                <option value="COMPUTER">Computer</option>
                                <option value="EQUIPMENT">Equipment</option>
                            </select>
                        </div>

                        {assetType === 'COMPUTER' && (
                            <div className="report-issue-field report-issue-full-field">
                                <label htmlFor="report-computer">Computer</label>
                                <select id="report-computer" value={computerId} onChange={event => setComputerId(event.target.value)}>
                                    <option value="">Select Computer</option>
                                    {filteredComputers.map(computer => <option key={computer.id} value={computer.id}>{computer.computer_name} — {computer.asset_tag || 'No asset tag'}</option>)}
                                </select>
                            </div>
                        )}

                        {assetType === 'EQUIPMENT' && (
                            <div className="report-issue-field">
                                <label htmlFor="report-equipment-type">Equipment Type</label>
                                <select id="report-equipment-type" value={equipmentType} onChange={event => { setEquipmentType(event.target.value); setEquipmentId('') }}>
                                    <option value="">Select Equipment Type</option>
                                    {equipmentTypes.map(type => <option key={type} value={type}>{type}</option>)}
                                </select>
                                {laboratoryId && equipmentTypes.length === 0 && <small className="report-issue-hint">No equipment is currently assigned to this laboratory.</small>}
                            </div>
                        )}

                        {assetType === 'EQUIPMENT' && (
                            <div className="report-issue-field">
                                <label htmlFor="report-equipment">Specific Equipment</label>
                                <select id="report-equipment" value={equipmentId} onChange={event => setEquipmentId(event.target.value)} disabled={!equipmentType}>
                                    <option value="">Select Specific Equipment</option>
                                    {filteredEquipment.map(item => <option key={item.id} value={item.id}>{equipmentOptionLabel(item)}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="report-issue-field report-issue-full-field">
                            <label htmlFor="report-description">Issue Description</label>
                            <textarea id="report-description" rows="6" value={issueDescription} onChange={event => setIssueDescription(event.target.value)} placeholder="Describe the problem clearly..." />
                        </div>
                    </div>

                    <div className="report-issue-actions">
                        <button type="button" className="report-issue-secondary" onClick={() => navigate(isDean ? '/dean-dashboard' : '/teacher-dashboard')}>Back</button>
                        <button type="submit" className="report-issue-primary" disabled={isSubmitting || loadingAssets}>{isSubmitting ? 'Submitting...' : 'Submit Report'}</button>
                    </div>
                </form>
            </section>
        </MISPageShell>
    )
}

export default ReportIssue
