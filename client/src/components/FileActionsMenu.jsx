import { useEffect, useRef, useState } from 'react'
import ExcelImportPanel from './ExcelImportPanel.jsx'
import { getFileActions } from '../utils/fileActions.js'
import './FileActionsMenu.css'

// "File Actions" dropdown: Import Excel, Export Excel, and Save as PDF.
// The pages keep their own export / PDF handlers and the existing ExcelImportPanel (preview + confirm) flow; this only groups them.
export default function FileActionsMenu({ module, role, pdf = false, importProps, onExport, onPdf, buttonClassName = 'btn-primary' }) {
    const [open, setOpen] = useState(false)
    const wrapRef = useRef(null)
    const importRef = useRef(null)
    const items = getFileActions(module, role, { pdf })

    useEffect(() => {
        if (!open) return undefined
        const onPointerDown = event => { if (!wrapRef.current?.contains(event.target)) setOpen(false) }
        const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
    }, [open])

    if (!items.length) return null

    async function run(key) {
        setOpen(false)
        if (key === 'import') return importRef.current?.open()
        if (key === 'export') return onExport?.()
        if (key === 'pdf') return onPdf?.()
    }

    return <div className="file-actions no-print" ref={wrapRef}>
        <button type="button" className={buttonClassName} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)}>File Actions <span aria-hidden="true">▾</span></button>
        {open && <ul className="file-actions-menu" role="menu" aria-label="File Actions">
            {items.map(item => <li key={item.key} role="none"><button type="button" role="menuitem" className="file-actions-item" data-action={item.key} onClick={() => run(item.key)}>{item.label}</button></li>)}
        </ul>}
        {items.some(item => item.key === 'import') && importProps && <ExcelImportPanel {...importProps} hideButton openRef={importRef} />}
    </div>
}
