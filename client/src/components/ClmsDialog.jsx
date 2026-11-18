import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import './ClmsDialog.css'

const DialogContext = createContext(null)

export function ClmsDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const resolver = useRef(null)
  const inputRef = useRef(null)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const toastRef = useRef(null) // mirrors `toast` synchronously so feedback never replaces an actionable Undo/Restore popup
  const setToastNow = useCallback((value) => { toastRef.current = value; setToast(value) }, [])

  const close = useCallback((result) => {
    resolver.current?.(result)
    resolver.current = null
    setDialog(null)
  }, [])

  const confirm = useCallback((message, options = {}) => new Promise((resolve) => {
    resolver.current = resolve
    setDialog({ type: 'confirm', title: options.title || 'Please confirm', message, confirmLabel: options.confirmLabel || 'Confirm', danger: Boolean(options.danger) })
  }), [])

  // OK-only information popup (used for "import complete" / "export complete").
  const notify = useCallback((message, options = {}) => new Promise((resolve) => {
    resolver.current = resolve
    setDialog({ type: 'notify', title: options.title || 'Done', message, confirmLabel: options.confirmLabel || 'OK' })
  }), [])

  const prompt = useCallback((message, options = {}) => new Promise((resolve) => {
    resolver.current = resolve
    setDialog({ type: 'prompt', title: options.title || 'Enter information', message, placeholder: options.placeholder || '', inputType: options.inputType || 'text', required: options.required !== false, confirmLabel: options.confirmLabel || 'Submit', value: '' })
  }), [])


  // "Others" flow shared by every dropdown: popup to type the new option -> Cancel/Confirm popup -> caller saves it.
  // Resolves with the value to use, or null if the user cancelled. If the typed value matches an existing option
  // (case-insensitive) that existing option is returned without asking to save again, so duplicates are never created.
  const askNewOption = useCallback(async (label, existingValues = []) => {
    const typed = await prompt(`Enter the new ${label}:`, { title: 'Others', placeholder: `New ${label}`, confirmLabel: 'Next' })
    const value = String(typed ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
    if (!value) return null
    const match = existingValues.find(item => String(item).trim().toLocaleLowerCase() === value.toLocaleLowerCase())
    if (match !== undefined) return { value: match, existing: true }
    const ok = await confirm(`Save “${value}” as a new ${label} option? It will be added to the dropdown permanently.`, { title: 'Confirm new option', confirmLabel: 'Confirm' })
    return ok ? { value, existing: false } : null
  }, [prompt, confirm])

  // Centered success/error feedback shown AFTER a data-changing operation (same popup as undoToast, no Undo button).
  const feedback = useCallback((message, type = 'success') => {
    if (!message) return
    const isError = type === 'error'
    if (toastRef.current?.onUndo && !toastRef.current.busy) return // keep the Restore/Undo popup the user may still need
    window.clearTimeout(toastTimer.current)
    setToastNow({ message, onUndo: null, busy: false, error: isError, label: 'Undo', title: isError ? 'Error' : 'Success' })
    toastTimer.current = window.setTimeout(() => setToastNow(null), isError ? 8000 : 5000)
  }, [setToastNow])

  const dismissToast = useCallback(() => { window.clearTimeout(toastTimer.current); setToastNow(null) }, [setToastNow])

  // Undo popup. onUndo MUST perform a real restore (API call); callers must not show this when an action cannot be reversed.
  const undoToast = useCallback((message, onUndo, options = {}) => {
    window.clearTimeout(toastTimer.current)
    // Centered popup. It stays until the user clicks Undo/Restore or X (there is no time limit; the server enforces none either).
    setToastNow({ message, onUndo, busy: false, error: Boolean(options.error), label: options.label || 'Undo', title: options.title || (options.label === 'Restore' ? 'Deleted' : 'Done') })
    if (options.durationMs) toastTimer.current = window.setTimeout(() => setToastNow(null), options.durationMs)
  }, [setToastNow])

  const runUndo = useCallback(async () => {
    if (!toast?.onUndo || toast.busy) return
    window.clearTimeout(toastTimer.current)
    setToastNow({ ...toast, busy: true })
    try {
      const resultMessage = await toast.onUndo()
      setToastNow({ message: typeof resultMessage === 'string' && resultMessage ? resultMessage : 'Action undone.', onUndo: null, busy: false, title: 'Restored' })
    } catch (error) {
      setToastNow({ message: error?.response?.data?.message || error?.message || 'Unable to undo this action.', onUndo: null, busy: false, error: true, title: 'Unable to restore' })
    }
    toastTimer.current = window.setTimeout(() => setToastNow(null), 6000)
  }, [toast, setToastNow])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    if (dialog) inputRef.current?.focus()
  }, [dialog])

  useEffect(() => {
    if (!dialog) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close(dialog.type === 'prompt' ? null : false)
      if (event.key === 'Enter' && dialog.type === 'confirm') close(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dialog, close])

  function submitPrompt(event) {
    event.preventDefault()
    const value = dialog?.value ?? ''
    if (dialog?.required && !value.trim()) return
    close(value)
  }

  return <DialogContext.Provider value={{ confirm, prompt, notify, undoToast, askNewOption, feedback }}>
    {children}
    {dialog && <div className="clms-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(dialog.type === 'prompt' ? null : false) }}>
      <section className="clms-dialog" role="dialog" aria-modal="true" aria-labelledby="clms-dialog-title">
        <h2 id="clms-dialog-title">{dialog.title}</h2>
        <p>{dialog.message}</p>
        {dialog.type === 'prompt' && <form onSubmit={submitPrompt}>
          <input ref={inputRef} type={dialog.inputType} value={dialog.value} placeholder={dialog.placeholder} onChange={(event) => setDialog((current) => ({ ...current, value: event.target.value }))} aria-label={dialog.message} autoComplete="new-password" />
          <div className="clms-dialog-actions">
            <button type="button" className="clms-dialog-secondary" onClick={() => close(null)}>Cancel</button>
            <button type="submit" className="clms-dialog-primary" disabled={dialog.required && !dialog.value.trim()}>{dialog.confirmLabel}</button>
          </div>
        </form>}
        {dialog.type === 'notify' && <div className="clms-dialog-actions"><button type="button" className="clms-dialog-primary" onClick={() => close(true)} autoFocus>{dialog.confirmLabel}</button></div>}
        {dialog.type === 'confirm' && <div className="clms-dialog-actions">
          <button type="button" className="clms-dialog-secondary" onClick={() => close(false)}>Cancel</button>
          <button type="button" className={dialog.danger ? 'clms-dialog-primary danger' : 'clms-dialog-primary'} onClick={() => close(true)}>{dialog.confirmLabel}</button>
        </div>}
      </section>
    </div>}
    {toast && <div className="clms-undo-backdrop" role="presentation">
      <section className={`clms-undo-popup${toast.error ? ' error' : ''}`} role="alertdialog" aria-modal="false" aria-live="polite" aria-label={toast.title}>
        <button type="button" className="clms-undo-close" onClick={dismissToast} aria-label="Close">×</button>
        <h2>{toast.title}</h2>
        <p className="clms-undo-message">{toast.message}</p>
        {toast.onUndo && <div className="clms-undo-actions"><button type="button" className="clms-undo-action" onClick={runUndo} disabled={toast.busy}>{toast.busy ? `${toast.label === 'Restore' ? 'Restoring' : 'Undoing'}…` : toast.label}</button></div>}
      </section>
    </div>}
  </DialogContext.Provider>
}

export function useClmsDialog() {
  const context = useContext(DialogContext)
  if (!context) throw new Error('useClmsDialog must be used within ClmsDialogProvider')
  return context
}

// Page banners (`message` + `messageType` state) become centered popups: the message is shown once and then cleared,
// so the same text can be shown again on a repeated attempt. `inferType` is used when a page has no separate type.
export function useCenteredFeedback(message, messageType, clear) {
  const { feedback } = useClmsDialog()
  useEffect(() => {
    if (!message) return
    const type = messageType || (/(unable|error|fail|cannot|can't|could not|not allowed|must |required|invalid|no longer|not found|denied|mismatch|enter )/i.test(message) ? 'error' : 'success')
    feedback(message, type)
    clear?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- show once per new message
  }, [message])
}
