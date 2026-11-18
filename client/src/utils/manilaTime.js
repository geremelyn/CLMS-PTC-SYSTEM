// Asia/Manila helpers for the client. "Today" and "now" must never depend on the browser's own timezone.
const TZ = 'Asia/Manila'
function parts(date, options) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...options }).formatToParts(date).map(part => [part.type, part.value]))
}
export function manilaToday(date = new Date()) {
  const p = parts(date, { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${p.year}-${p.month}-${p.day}`
}
// "HH:MM" in Manila (24h) - comparable as a string with the HH:MM times stored on reservations.
export function manilaClock(date = new Date()) {
  const p = parts(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}
export const MANILA_TIMEZONE = TZ
