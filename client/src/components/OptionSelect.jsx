import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './OptionSelect.css'

// Dropdown for fields that have a user-extendable "Others" list.
// options: [{ value, label, custom?, id? }]. ONLY options with custom === true get a delete symbol; fixed/default
// options never do. Choosing "Others" calls onOthers(); clicking the delete symbol calls onDeleteCustom(option)
// (the page shows the CLMS confirmation popup and the server refuses to delete an option that records still use).
export default function OptionSelect({ id, value, options, onChange, onOthers, onDeleteCustom, placeholder = 'Select', othersLabel = 'Others', disabled = false, required = false, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const current = options.find(option => String(option.value) === String(value))

  const place = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const height = listRef.current?.offsetHeight || 220
    const below = window.innerHeight - rect.bottom - 8
    const top = below >= Math.min(height, 220) || below >= rect.top ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)
    setPosition({ top, left: rect.left, width: rect.width, maxHeight: Math.max(120, Math.min(280, window.innerHeight - 16)) })
  }, [])

  useLayoutEffect(() => { if (open) place() }, [open, options.length, place])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => { if (!listRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false) }
    const onKeyDown = event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); triggerRef.current?.focus() } }
    const onViewport = event => { if (listRef.current?.contains(event?.target)) return; place() }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [open, place])

  function pick(option) { setOpen(false); if (String(option.value) !== String(value)) onChange?.(option.value, option) }
  function others() { setOpen(false); onOthers?.() }
  function remove(event, option) { event.preventDefault(); event.stopPropagation(); setOpen(false); onDeleteCustom?.(option) }

  const list = open && !disabled ? (
    <ul ref={listRef} className="clms-optselect-list" role="listbox" aria-label={ariaLabel || placeholder} style={position ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight } : { visibility: 'hidden' }}>
      {options.map(option => {
        const selected = String(option.value) === String(value)
        return <li key={`${option.id ?? ''}:${option.value}`} role="option" aria-selected={selected} className={`clms-optselect-row${selected ? ' selected' : ''}`}>
          <button type="button" className="clms-optselect-pick" onClick={() => pick(option)}>{option.label ?? option.value}{option.custom && <small className="clms-optselect-tag">custom</small>}</button>
          {option.custom && onDeleteCustom && <button type="button" className="clms-optselect-delete" onClick={event => remove(event, option)} aria-label={`Delete custom option ${option.label ?? option.value}`} title="Delete this custom option">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z" /></svg>
          </button>}
        </li>
      })}
      {onOthers && <li role="option" aria-selected="false" className="clms-optselect-row clms-optselect-others"><button type="button" className="clms-optselect-pick" onClick={others}>{othersLabel}</button></li>}
    </ul>
  ) : null

  return <div className="clms-optselect">
    <button ref={triggerRef} id={id} type="button" className="clms-optselect-trigger" onClick={() => !disabled && setOpen(o => !o)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
      <span>{current ? (current.label ?? current.value) : (value ? String(value) : placeholder)}</span><span aria-hidden="true">▾</span>
    </button>
    {required && <input className="clms-optselect-required" tabIndex={-1} aria-hidden="true" required value={value || ''} onChange={() => {}} />}
    {list && createPortal(list, document.body)}
  </div>
}
