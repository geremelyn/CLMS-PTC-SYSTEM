'use strict'
// CP58: source-level checks (no browser/renderer is available): cancellation notes are centered, nothing else was restyled.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = f => fs.readFileSync(path.resolve(__dirname, '../../client/src/pages', f), 'utf8')
const reservations = read('Reservations.jsx'), my = read('MyReservations.jsx'), resCss = read('Reservations.css'), myCss = read('MyReservations.css')

test('Super Admin / MIS Staff table: both the header and the cell of the Cancellation Note column carry the centering class', () => {
  assert.match(reservations, /<th className="reservation-note-cell">Notes<\/th>/) // CP84: renamed from "Cancellation Note"; also shows the decline reason
  assert.match(reservations, /<td className="reservation-note-cell">\{item\.cancellation_note \|\| item\.decision_note \|\| '—'\}<\/td>/)
  assert.equal((reservations.match(/reservation-note-cell/g) || []).length, 2) // only that column
  assert.match(resCss, /\.reservation-table td\.reservation-note-cell[\s\S]*text-align:\s*center/)
})
test('Dean / Teacher My Reservations: the cancellation note is centered; the holiday-conflict note is not', () => {
  assert.match(my, /className="reservation-cancel-note reservation-cancel-note-centered">\s*<strong>Note:<\/strong> \{reservation\.cancellation_note\}/)
  assert.equal((my.match(/reservation-cancel-note-centered/g) || []).length, 1)
  assert.match(myCss, /\.reservation-cancel-note\.reservation-cancel-note-centered \{ text-align: center; margin-left: auto; margin-right: auto; \}/)
})
test('no behaviour changed: cancel handlers still send cancellation_note and the automatic-cancel guard is intact', () => {
  assert.match(reservations, /cancellation_note: cancellationNote\.trim\(\)/); assert.match(reservations, /startsWith\('Automatically cancelled:'\)\) return false/)
  assert.match(my, /cancellation_note: cancellationReason\.trim\(\)/)
})
