'use strict'
// CP180 regression tests for two defects found while auditing the CP179 transfer fix. MOCKED database (NOT real MySQL/MariaDB):
// the in-memory store from the CP179 test is reused by loading its helpers through a tiny copy of the same lock emulation.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
// Reuse the CP179 mock verbatim (everything above the first test()).
const src = fs.readFileSync(path.join(__dirname, 'computerTransferConcurrencyCp179.test.js'), 'utf8')
const head = src.slice(0, src.indexOf("test('control:")).replace(/^'use strict'/, '').replace(/const test = require\('node:test'\)\n/, '').replace(/const assert = require\('node:assert\/strict'\)\n/, '')
const mod = new Function('require', '__dirname', head + '\nreturn { load, res, body, put, pcs, inLab }')
const { load, res, body, put, pcs, inLab } = mod(require, __dirname)

test('CP180 #1: maintenance sync receives the condition read UNDER the row lock, not the stale pre-check value (transfer path)', async () => {
  // pre-check sees WORKING; a concurrent edit commits NOT WORKING before our locks are granted (simulated by changing the row inside getConnection).
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) })
  const db = require(path.resolve(__dirname, '../database/db.js')); const gc = db.getConnection
  db.getConnection = cb => { ctx.state.computers[0].condition = 'NOT WORKING'; gc(cb) }
  const r = await put(ctx, 10, 1, { condition: 'WORKING' })
  assert.equal(r.code, 200); assert.equal(ctx.state.syncCalls.length, 1)
  assert.equal(ctx.state.syncCalls[0].o.before, 'NOT WORKING', 'before must be the locked value')
  assert.equal(ctx.state.syncCalls[0].o.after, 'WORKING')
})
test('CP180 #1b: audit "Transferred" uses the laboratory read under the lock (computer concurrently moved into the destination = plain update, not a transfer)', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(2, [10]) })
  const db = require(path.resolve(__dirname, '../database/db.js')); const gc = db.getConnection
  db.getConnection = cb => { ctx.state.computers[0].laboratory_id = 1; gc(cb) }
  const r = await put(ctx, 10, 1); assert.equal(r.code, 200)
  assert.ok(ctx.audits.some(a => a[1] === 'ASSET UPDATE')); assert.ok(!ctx.audits.some(a => a[1] === 'WORKSTATION ASSIGNMENT'))
})
// CP182: plain edits are now transactional too; the stale-decision race is simulated by changing the row inside getConnection (after the unlocked
// pre-check, before the locks), exactly like CP180 #1.
const flipOnce = (ctx, mutate) => { const db = require(path.resolve(__dirname, '../database/db.js')); const gc = db.getConnection; let done = false; db.getConnection = cb => { if (!done) { done = true; mutate() } gc(cb) } }
test('CP180 #2: a plain edit decided from a stale pre-check cannot move a computer back into a FULL laboratory - it is re-evaluated through the locked transfer path (400)', async () => {
  const ctx = load({ labs: { 1: 2, 2: 5 }, computers: [...pcs(1, [10, 1])] })
  flipOnce(ctx, () => { ctx.state.computers.find(c => c.id === 10).laboratory_id = 2; ctx.state.computers.push({ id: 2, computer_name: 'PC-2', laboratory_id: 1 }) })
  const r = await put(ctx, 10, 1)
  assert.equal(r.code, 400); assert.equal(r.body.message, 'Laboratory reached its limit')
  assert.equal(inLab(ctx, 1), 2, 'laboratory 1 must not exceed its capacity of 2'); assert.equal(ctx.state.computers.find(c => c.id === 10).laboratory_id, 2)
  assert.equal(ctx.state.released, ctx.state.opened)
})
test('CP180 #2b: same stale situation but the destination has room -> the retry succeeds as a transfer (200) and is audited as one', async () => {
  const ctx = load({ labs: { 1: 5, 2: 5 }, computers: pcs(1, [10]) })
  flipOnce(ctx, () => { ctx.state.computers[0].laboratory_id = 2 })
  const r = await put(ctx, 10, 1); assert.equal(r.code, 200); assert.equal(ctx.state.computers[0].laboratory_id, 1)
  assert.ok(ctx.audits.some(a => a[1] === 'WORKSTATION ASSIGNMENT'))
})
test('CP180 #2c: ordinary same-laboratory edit is a single UPDATE (200, ASSET UPDATE audit); a computer deleted between the pre-check and the lock -> 404; a computer displaced again before the retry still ends up correctly transferred (200)', async () => {
  let ctx = load({ labs: { 1: 1 }, computers: pcs(1, [1]) })
  let r = await put(ctx, 1, 1, { computer_name: 'Renamed' }); assert.equal(r.code, 200); assert.equal(ctx.state.sql.filter(s => s.startsWith('UPDATE computers SET')).length, 1)
  ctx = load({ labs: { 1: 5 }, computers: pcs(1, [1]) }); flipOnce(ctx, () => { ctx.state.computers.length = 0 })
  r = await put(ctx, 1, 1); assert.equal(r.code, 404); assert.equal(r.body.message, 'Computer not found'); assert.equal(ctx.state.released, ctx.state.opened)
  ctx = load({ labs: { 1: 5, 2: 5, 3: 5 }, computers: pcs(1, [1]) })
  const db = require(path.resolve(__dirname, '../database/db.js')); const gc = db.getConnection; let n = 0
  db.getConnection = cb => { n++; ctx.state.computers[0].laboratory_id = n === 1 ? 2 : 3; gc(cb) }   // moves again before the retry's locks as well
  r = await put(ctx, 1, 1)
  assert.equal(r.code, 200); assert.equal(ctx.state.computers[0].laboratory_id, 1)   // the retry takes the locked transfer path and re-reads the row under the lock
})
