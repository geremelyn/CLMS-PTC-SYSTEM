'use strict'
// DB-aware holiday helpers shared by the reservation and holiday controllers.
// `query` is any (sql, params) => Promise<rows> function (pool or transaction connection).
const holidays = require('./philippineHolidays.js')
const RESERVATION_POLICY = require('../config/reservationPolicy.js')

function poolQuery(db) {
  return (sql, params = []) => new Promise((resolve, reject) => {
    try { db.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)) } catch (error) { reject(error) }
  })
}

// Effective record for a date. The database row is authoritative (including a deactivated row, which means MIS
// removed/overrode that date). With no row, the built-in baseline applies. If the table cannot be read, the
// baseline is used so Sundays/holidays are still blocked (fail-safe, never fail-open).
async function findHoliday(query, dateString) {
  if (!holidays.isValidDateString(dateString)) return null
  try {
    const rows = await query("SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, holiday_type, custom_type_label, source, is_verified, is_active FROM holidays WHERE holiday_date = ? LIMIT 1", [dateString])
    if (rows && rows.length) return rows[0]
  } catch (error) {
    if (error && error.code !== 'ER_NO_SUCH_TABLE') console.warn('Holiday lookup failed, using built-in baseline:', error.code || error.message)
  }
  return holidays.baselineForDate(dateString)
}

async function checkReservableDate(query, dateString) {
  const holiday = await findHoliday(query, dateString)
  return holidays.evaluateReservableDate(dateString, holiday, { blockSunday: RESERVATION_POLICY.blockSunday })
}

// Callback flavour for synchronous controllers (createReservation). Same rules as checkReservableDate.
// `done` guards against re-entering the callback if downstream code throws inside db.query's callback.
function checkReservableDateCb(db, dateString, callback) {
  let done = false
  const finish = holiday => {
    if (done) return
    done = true
    callback(holidays.evaluateReservableDate(dateString, holiday, { blockSunday: RESERVATION_POLICY.blockSunday }))
  }
  if (!holidays.isValidDateString(dateString)) return finish(null)
  try {
    db.query("SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, holiday_type, custom_type_label, source, is_verified, is_active FROM holidays WHERE holiday_date = ? LIMIT 1", [dateString], (error, rows) => {
      if (!error && rows && rows.length) return finish(rows[0])
      if (error && error.code !== 'ER_NO_SUCH_TABLE') console.warn('Holiday lookup failed, using built-in baseline:', error.code || error.message)
      finish(holidays.baselineForDate(dateString))
    })
  } catch (error) {
    if (done) throw error
    finish(holidays.baselineForDate(dateString))
  }
}

module.exports = { poolQuery, findHoliday, checkReservableDate, checkReservableDateCb }
