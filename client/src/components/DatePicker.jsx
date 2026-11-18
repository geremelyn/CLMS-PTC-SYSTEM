import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isClosedHoliday, isSpecialWorkingDay, useHolidayMap } from '../utils/holidays'
import { manilaToday } from '../utils/manilaTime'
import './DatePicker.css'

function parseLocalDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function toDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function labelDate(value) {
  const date = parseLocalDate(value)
  return date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Choose a date'
}

// Calendar DIALOG. Clicking the date field opens a centered popup; a day is only highlighted (draft) until the user
// presses Save, which commits it through onChange. Cancel, the X, Escape or clicking the backdrop close the popup and
// leave the saved value untouched.
// Reservation mode (default, restrictDays=true): Sundays, past dates (before `min`), regular holidays and special
// non-working days cannot be chosen; special WORKING days stay selectable; holiday names appear on cells and under the month.
// Relaxed mode (restrictDays=false) is for non-reservation fields (audit filters, holiday/laboratory dates): only
// `min` / `max` apply. allowClear adds a Clear button for optional dates. showHolidayList=false hides the
// "Holidays this month" box (Dean/Teacher reservation calendar); closed days stay disabled either way.
export default function DatePicker({ id, value, min, max, onChange, disabled = false, showHolidayList = true, restrictDays = true, allowClear = false, required = false, title = 'Choose a date', placeholder = 'Choose a date' }) {
  const selectedDate = parseLocalDate(value)
  const minimumDate = parseLocalDate(min)
  const initialDate = selectedDate || minimumDate || parseLocalDate(manilaToday())
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const [month, setMonth] = useState(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1))
  const triggerRef = useRef(null)
  const dialogRef = useRef(null)
  const { map: holidayMap } = useHolidayMap(restrictDays && open ? [month.getFullYear()] : [])

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    return [...Array(first.getDay()).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)]
  }, [month])

  const previousMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1)
  const previousYear = new Date(month.getFullYear() - 1, month.getMonth(), 1)
  const minMonth = minimumDate ? new Date(minimumDate.getFullYear(), minimumDate.getMonth(), 1) : null
  const canGoBack = !minMonth || previousMonth >= minMonth
  const canGoBackYear = !minMonth || previousYear >= minMonth

  const monthHolidays = useMemo(() => {
    if (!restrictDays) return []
    const prefix = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-`
    return [...holidayMap.entries()].filter(([date]) => date.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([, holiday]) => holiday)
  }, [holidayMap, month, restrictDays])

  const cancel = useCallback(() => { setOpen(false); triggerRef.current?.focus() }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => { if (event.key === 'Escape') { event.stopPropagation(); cancel() } }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, cancel])

  useEffect(() => { if (open) dialogRef.current?.focus() }, [open])

  function isBlocked(dateValue, date) {
    if (min && dateValue < min) return true
    if (max && dateValue > max) return true
    if (restrictDays && (date.getDay() === 0 || isClosedHoliday(holidayMap.get(dateValue)))) return true
    return false
  }

  function chooseDay(day) {
    if (!day) return
    const date = new Date(month.getFullYear(), month.getMonth(), day)
    const dateValue = toDateValue(date)
    if (isBlocked(dateValue, date)) return
    setDraft(dateValue) // highlight only; nothing is saved until Save
  }

  function openPicker() {
    if (disabled) return
    const base = parseLocalDate(value) || minimumDate || parseLocalDate(manilaToday())
    setDraft(value || '')
    setMonth(new Date(base.getFullYear(), base.getMonth(), 1))
    setOpen(true)
  }

  function save() {
    if (!draft && !allowClear) return
    if (draft) { const date = parseLocalDate(draft); if (!date || isBlocked(draft, date)) return }
    setOpen(false)
    if (draft || value) onChange?.(draft) // re-saving the same date still re-triggers the caller (e.g. the Morning/Afternoon popup)
    triggerRef.current?.focus()
  }

  const selectedHoliday = restrictDays && value ? holidayMap.get(value) : null
  const draftLabel = draft ? labelDate(draft) : 'No date selected'
  const canSave = Boolean(draft) || allowClear

  const dialog = open && !disabled ? (
    <div className="clms-date-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) cancel() }}>
      <div ref={dialogRef} tabIndex={-1} className="clms-date-popover" role="dialog" aria-modal="true" aria-label={title}>
        <div className="clms-date-head"><h2>{title}</h2><button type="button" className="clms-date-x" onClick={cancel} aria-label="Close without saving">×</button></div>
        <div className="clms-date-month-bar">
          <button type="button" onClick={() => setMonth(previousYear)} disabled={!canGoBackYear} aria-label="Previous year">«</button>
          <button type="button" onClick={() => setMonth(previousMonth)} disabled={!canGoBack} aria-label="Previous month">‹</button>
          <strong>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear() + 1, month.getMonth(), 1))} aria-label="Next year">»</button>
        </div>
        <div className="clms-date-grid clms-date-weekdays">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}
        </div>
        <div className="clms-date-grid">
          {days.map((day, index) => {
            if (!day) return <span key={`blank-${index}`} className="clms-date-blank" />
            const date = new Date(month.getFullYear(), month.getMonth(), day)
            const dateValue = toDateValue(date)
            const holiday = restrictDays ? holidayMap.get(dateValue) : null
            const closed = isClosedHoliday(holiday)
            const working = isSpecialWorkingDay(holiday)
            const isSunday = restrictDays && date.getDay() === 0
            const blocked = isBlocked(dateValue, date)
            const isSelected = dateValue === draft
            const longDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            const reason = closed ? `${holiday.name} (${holiday.type_label}) - unavailable` : working ? `${holiday.name} (${holiday.type_label}) - open for reservations` : isSunday ? 'Sunday - unavailable' : ''
            return <button key={dateValue} type="button" className={[isSelected && 'selected', isSunday && 'sunday', closed && 'holiday', working && 'workday'].filter(Boolean).join(' ')} disabled={blocked} onClick={() => chooseDay(day)} title={reason || undefined} aria-pressed={isSelected} aria-label={`${longDate}${reason ? `, ${reason}` : ''}`}>{day}{(closed || working) && <i aria-hidden="true" />}</button>
          })}
        </div>
        {showHolidayList && monthHolidays.length > 0 && <ul className="clms-date-holidays" aria-label="Holidays this month">
          {monthHolidays.map(holiday => <li key={holiday.holiday_date} className={isClosedHoliday(holiday) ? 'closed' : 'working'}><b>{Number(holiday.holiday_date.slice(8))}</b> {holiday.name}<small>{isClosedHoliday(holiday) ? holiday.type_label : 'Special Working Day - open'}</small></li>)}
        </ul>}
        {restrictDays && <p className="clms-date-note">Sundays, holidays and past dates are unavailable.</p>}
        <p className="clms-date-chosen" aria-live="polite">Selected: <strong>{draftLabel}</strong></p>
        <div className="clms-date-actions">
          {allowClear && <button type="button" className="clms-date-clear" onClick={() => setDraft('')} disabled={!draft}>Clear</button>}
          <button type="button" className="clms-date-cancel" onClick={cancel}>Cancel</button>
          <button type="button" className="clms-date-save" onClick={save} disabled={!canSave}>Save</button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="clms-date-picker">
      <button ref={triggerRef} id={id} type="button" className="clms-date-trigger" onClick={openPicker} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}>
        <span>{value ? labelDate(value) : placeholder}{selectedHoliday && isSpecialWorkingDay(selectedHoliday) ? ` · ${selectedHoliday.name}` : ''}</span><span aria-hidden="true">📅</span>
      </button>
      {required && <input className="clms-date-required" tabIndex={-1} aria-hidden="true" required value={value || ''} onChange={() => {}} />}
      {dialog && createPortal(dialog, document.body)}
    </div>
  )
}
