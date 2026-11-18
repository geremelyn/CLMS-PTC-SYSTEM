import { useEffect, useState } from 'react'
import './PagePager.css'

// CP187: shared pager used by every list page: "Showing x-y of n" + Previous + typeable page number + Next.
// No rows-per-page dropdown (pages show 5 rows). The typed page is clamped to 1..totalPages on Enter or blur;
// an empty / invalid entry returns to the current page.
export default function PagePager({ page, totalPages, onPage, summary, className = '', ariaLabel = 'Pagination' }) {
  const [input, setInput] = useState(String(page))
  useEffect(() => { setInput(String(page)) }, [page])
  function go(value) {
    const wanted = Number.parseInt(value, 10)
    const next = Number.isInteger(wanted) ? Math.min(Math.max(1, wanted), totalPages) : page
    setInput(String(next))
    if (next !== page) onPage(next)
  }
  return <div className={`clms-pager no-print ${className}`.trim()} role="navigation" aria-label={ariaLabel}>
    <span className="clms-pager-summary">{summary}</span>
    <button type="button" onClick={() => go(page - 1)} disabled={page <= 1}>Previous</button>
    <label className="clms-page-jump">Page <input type="text" inputMode="numeric" aria-label="Page number" value={input}
      onChange={event => setInput(event.target.value.replace(/\D/g, '').slice(0, 5))}
      onBlur={() => go(input)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); go(input) } }} /> of {totalPages}</label>
    <button type="button" onClick={() => go(page + 1)} disabled={page >= totalPages}>Next</button>
  </div>
}
