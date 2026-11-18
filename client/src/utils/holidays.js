import { useEffect, useState } from 'react'
import api from '../api'

// Client-side view of the Philippine holiday table (server is authoritative; it re-checks every booking).
// Dates are YYYY-MM-DD strings in Asia/Manila; no timezone math happens on the client.
const cache = new Map() // year -> Promise<Map<dateString, holiday>>
const listeners = new Set()

export function loadHolidayYear(year) {
  const key = Number(year)
  if (!Number.isInteger(key)) return Promise.resolve(new Map())
  if (!cache.has(key)) {
    const request = api.get('/holidays', { params: { year: key } })
      .then(response => new Map((response.data?.holidays || []).filter(item => item.is_active).map(item => [item.holiday_date, item])))
      .catch(() => { cache.delete(key); return new Map() })
    cache.set(key, request)
  }
  return cache.get(key)
}
// Call after MIS adds/edits/removes a holiday so open calendars refetch.
export function clearHolidayCache() { cache.clear(); listeners.forEach(listener => listener()) }

export const isClosedHoliday = holiday => Boolean(holiday?.blocks_reservations)
export const isSpecialWorkingDay = holiday => Boolean(holiday) && !holiday.blocks_reservations

// Returns { map, version } for the given years; re-renders when the cache is cleared.
export function useHolidayMap(years) {
  const [state, setState] = useState({ map: new Map(), version: 0 })
  const [refresh, setRefresh] = useState(0)
  const key = [...new Set(years.filter(Number.isInteger))].sort().join(',')
  useEffect(() => {
    const listener = () => setRefresh(value => value + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => {
    let cancelled = false
    const list = key ? key.split(',').map(Number) : []
    Promise.all(list.map(loadHolidayYear)).then(maps => {
      if (cancelled) return
      const merged = new Map()
      maps.forEach(map => map.forEach((value, date) => merged.set(date, value)))
      setState(current => ({ map: merged, version: current.version + 1 }))
    })
    return () => { cancelled = true }
  }, [key, refresh])
  return state
}
