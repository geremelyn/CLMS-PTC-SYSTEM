import { useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../api'
import { useClmsDialog } from './ClmsDialog.jsx'
import { describeRequestFailure, describeRowDetails, explainRowError, summarizeRowProblems } from '../utils/importErrors.js'
import './ExcelImportPanel.css'

// "Import Excel" button. Picking a workbook opens a preview window; nothing is saved until the user
// confirms, and the server imports all rows in one transaction (all-or-nothing).
export default function ExcelImportPanel({ endpoint, onImported, label = 'Excel import', buttonLabel = 'Import Excel', className = 'btn-secondary', disabled = false, hideButton = false, openRef = null, fieldLabels = null, fixedLayout = false }) {
    const { confirm, notify } = useClmsDialog()
    const fileInput = useRef(null)
    const [preview, setPreview] = useState(null)
    const [fileName, setFileName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    // File Actions menu opens the file chooser through this handle; the preview/confirm flow below is unchanged.
    useImperativeHandle(openRef, () => ({ open: () => fileInput.current?.click() }), [])

    function reset() { setPreview(null); setFileName(''); setError(''); if (fileInput.current) fileInput.current.value = '' }

    async function inspectFile(event) {
        const selected = event.target.files?.[0]
        if (!selected) return
        setError(''); setPreview(null); setFileName(selected.name)
        if (!selected.name.toLowerCase().endsWith('.xlsx')) { setError('Choose an .xlsx workbook.'); setPreview({ rows: [] }); return }
        if (selected.size > 5 * 1024 * 1024) { setError('The workbook must be 5 MB or smaller.'); setPreview({ rows: [] }); return }
        // CP71: ask first. Nothing is read, previewed or uploaded until the user confirms; Cancel leaves everything untouched.
        if (!await confirm(`Import the selected Excel file “${selected.name}”? The file will be checked and previewed first; nothing is saved until you confirm the preview.`, { title: 'Confirm Excel import', confirmLabel: 'Confirm' })) { reset(); return }
        setBusy(true); setPreview({ rows: [], loading: true })
        try {
            const body = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Unable to read selected workbook.')); reader.onload = () => resolve({ fileName: selected.name, fileBase64: String(reader.result).split(',')[1] || '' }); reader.readAsDataURL(selected) })
            const response = await api.post(`${endpoint}/import-preview`, body)
            setPreview(response.data)
            if (response.data.errorCount) setError(summarizeRowProblems(response.data.rows))
        } catch (err) { setError(describeRequestFailure(err, 'preview')); setPreview({ rows: [] }) }
        finally { setBusy(false) }
    }

    async function importRows() {
        if (!preview?.allValid || !preview.rows?.length) return
        if (!await confirm(`Import ${preview.rows.length} ${label.toLowerCase()} record(s)? All rows are saved together; if any row fails, nothing is saved.`, { title: 'Import Excel', confirmLabel: 'Import' })) return
        setBusy(true); setError('')
        try {
            const response = await api.post(`${endpoint}/import`, { rows: preview.rows })
            const message = response.data.message || 'Import completed.'
            reset()
            await onImported?.()
            await notify(message, { title: 'Import complete' })
        } catch (err) {
            const details = err.response?.data?.rows || []
            const detailText = describeRowDetails(details)
            setError([describeRequestFailure(err, 'import'), detailText].filter(Boolean).join('\n'))
        } finally { setBusy(false) }
    }

    return <>
        <input ref={fileInput} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={inspectFile} />
        {!hideButton && <button type="button" className={className} disabled={disabled || busy} onClick={() => fileInput.current?.click()}>{buttonLabel}</button>}
        {/* CP188: rendered at the page root. Inside the page, an ancestor with transform / backdrop-filter becomes the containing block of position:fixed, so the popup was placed relative to the table area (cut off, off-screen Import button). */}
        {preview && createPortal(<div className="excel-import-backdrop" role="presentation"><section className={`excel-import-modal${fixedLayout ? ' excel-import-modal-fixed' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
            <div className="excel-import-heading"><strong>Import Excel — {fileName}</strong>{!fixedLayout && <button type="button" className="excel-import-close" onClick={reset} aria-label="Close">×</button>}</div>
            {preview.loading && <p className="excel-import-summary">Checking workbook…</p>}
            {error && <p className="excel-import-error" role="alert">{error}</p>}
            {!preview.loading && preview.rows?.length > 0 && <>
                <p className="excel-import-summary">{preview.validCount} valid row(s), {preview.errorCount} row(s) with errors. {preview.allValid ? 'Ready to import.' : 'Fix all errors in the file before importing.'}</p>
                <div className="excel-import-preview"><table><thead><tr><th>Excel row</th><th>Data</th><th>Validation</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{Object.entries(row.data || {}).filter(([key]) => key !== 'password').map(([key, value]) => `${fieldLabels?.[key] ?? key.replaceAll('_', ' ')}: ${value ?? ''}`).join(' · ')}</td><td>{row.valid ? 'Valid' : row.errors.map((message, index) => { const x = explainRowError(message); return <div key={index} className="excel-import-row-error"><strong>{x.kind}:</strong> {x.message}{x.tip && <em> {x.tip}</em>}</div> })}</td></tr>)}</tbody></table></div>
            </>}
            <div className="excel-import-actions"><button type="button" className="btn-secondary" onClick={reset} disabled={busy}>Cancel</button><button type="button" className="btn-primary" onClick={importRows} disabled={busy || !preview.allValid || !preview.rows?.length}>{busy ? 'Working…' : 'Import'}</button></div>
        </section></div>, document.body)}
    </>
}
