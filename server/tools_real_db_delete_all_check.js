'use strict'
// REAL MySQL/MariaDB check for Reservations "Delete All" + Recycle Bin restore.   *** NOT RUN in CP16 (no database was available) ***
// Uses the real server/database/db.js pool and the real controllers. It inserts 450 marker reservations, deletes them all
// through deleteReservations (chunked), verifies the Recycle Bin rows, restores them, then removes every marker row.
// SAFETY: it refuses to run unless DB_NAME ends with "_test" and CLMS_REAL_DB_CHECK=YES. Never point it at production data.
//   cd server && DB_NAME=ptc_clms_test CLMS_REAL_DB_CHECK=YES node tools_real_db_delete_all_check.js
require('dotenv').config()
const MARK = 'CP16-DELETE-ALL-CHECK'
if (process.env.CLMS_REAL_DB_CHECK !== 'YES' || !/_test$/i.test(process.env.DB_NAME || '')) { console.error('Refusing to run: set CLMS_REAL_DB_CHECK=YES and DB_NAME=<database ending in _test>.'); process.exit(2) }
const db = require('./database/db.js'), bin = require('./controllers/recycleBinController.js')
const q = (sql, v = []) => new Promise((ok, no) => db.query(sql, v, (e, r) => e ? no(e) : ok(r)))
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
const results = []; const check = (name, pass, extra = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
;(async () => {
  const [mis] = await q("SELECT id FROM users WHERE role='MIS' LIMIT 1"), [lab] = await q('SELECT id FROM laboratories LIMIT 1')
  if (!mis || !lab) throw new Error('Need at least one MIS user and one laboratory in the test database.')
  try {
    const rows = Array.from({ length: 450 }, (_, i) => [lab.id, mis.id, '2030-01-05', '08:00:00', '09:00:00', MARK, 'DECLINED', MARK])
    await q('INSERT INTO reservations (laboratory_id, reserved_by, reservation_date, start_time, end_time, purpose, status, subject_name) VALUES ?', [rows])
    const ids = (await q('SELECT id FROM reservations WHERE subject_name = ?', [MARK])).map(r => r.id)
    check('seeded 450 marker reservations', ids.length === 450, `(${ids.length})`)
    const del = res(); await bin.deleteReservations({ body: { ids, skipMissing: true }, user: { id: mis.id, role: 'MIS' } }, del)
    check('Delete All returns 200 and deletedCount 450', del.code === 200 && del.body?.deletedCount === 450, JSON.stringify(del.body).slice(0, 160))
    check('no marker reservations remain', (await q('SELECT COUNT(*) n FROM reservations WHERE subject_name = ?', [MARK]))[0].n === 0)
    check('450 Recycle Bin rows exist', (await q("SELECT COUNT(*) n FROM recycle_bin WHERE entity_type='reservations' AND restored_at IS NULL AND label LIKE 'Reservation #%' AND snapshot_json LIKE ?", [`%${MARK}%`]))[0].n === 450)
    const back = res(); await bin.restoreRecycleItems({ body: { ids: del.body?.recycleIds || [] }, user: { id: mis.id, role: 'MIS' } }, back)
    check('restore returns 200', back.code === 200, JSON.stringify(back.body).slice(0, 160))
    check('450 reservations restored', (await q('SELECT COUNT(*) n FROM reservations WHERE subject_name = ?', [MARK]))[0].n === 450)
  } finally {
    await q('DELETE FROM reservations WHERE subject_name = ?', [MARK])
    await q("DELETE FROM recycle_bin WHERE entity_type='reservations' AND snapshot_json LIKE ?", [`%${MARK}%`])
    console.log('marker rows cleaned up')
  }
})().catch(e => { console.error('ERROR', e.message); results.push(false) }).finally(() => { console.log(results.every(Boolean) && results.length ? 'ALL PASS' : 'FAILED'); process.exit(results.every(Boolean) && results.length ? 0 : 1) })
