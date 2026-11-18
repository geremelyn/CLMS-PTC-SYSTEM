const test = require('node:test')
const assert = require('node:assert/strict')
const { createSessionToken, verifySessionToken, tokenHash } = require('../utils/sessionToken.js')
const { getManilaDateString, getManilaTimeString, getManilaMinutes, isValidDateString, isSundayDateString, getReservationSession } = require('../controllers/reservationController.js')

test('signed session tokens preserve valid user ID zero', () => {
    const token = createSessionToken(0)
    assert.equal(verifySessionToken(token)?.userId, 0)
    assert.equal(tokenHash(token).length, 64)
})

test('signed session tokens reject tampering', () => {
    const token = createSessionToken(12)
    const [payload, signature] = token.split('.')
    const replacement = signature[0] === 'a' ? 'b' : 'a'
    const tampered = `${payload}.${replacement}${signature.slice(1)}`
    assert.equal(verifySessionToken(tampered), null)
})

test('reservation date validation rejects invalid calendar dates', () => {
    assert.equal(isValidDateString('2026-10-18'), true)
    assert.equal(isValidDateString('2026-02-29'), false)
    assert.equal(isValidDateString('18-10-2026'), false)
})

test('Sunday reservation dates are identified without local-timezone dependence', () => {
    assert.equal(isSundayDateString('2026-10-18'), true)
    assert.equal(isSundayDateString('2026-10-19'), false)
    assert.equal(isSundayDateString('not-a-date'), false)
})

test('Manila date/time helpers use Asia/Manila independent of server timezone', () => {
    const utcInstant = new Date('2026-10-17T17:30:00.000Z')
    assert.equal(getManilaDateString(utcInstant), '2026-10-18')
    assert.equal(getManilaTimeString(utcInstant), '01:30:00')
    assert.equal(getManilaMinutes(utcInstant), 90)
})


test('reservation time rules: custom times allowed, no fixed morning/afternoon sessions', () => {
    assert.deepEqual(getReservationSession('09:00', '10:00'), { valid: true, message: '' })
    assert.deepEqual(getReservationSession('12:00', '13:00'), { valid: true, message: '' })
    assert.equal(getReservationSession('11:00', '12:30').valid, true, 'crossing 12:00 is allowed by default')
    assert.equal(getReservationSession('08:00', '17:00').valid, true)
    assert.equal(getReservationSession('13:00', '12:30').valid, false)
    assert.equal(getReservationSession('10:00', '10:00').valid, false)
    assert.equal(getReservationSession('25:00', '26:00').valid, false)
})
test('no hidden morning/afternoon rule: reservations may cross 12:00 and CLMS_BLOCK_CROSS_NOON has no effect', () => {
    const policyPath = require.resolve('../config/reservationPolicy.js'), ctrlPath = require.resolve('../controllers/reservationController.js')
    process.env.CLMS_BLOCK_CROSS_NOON = 'true'; delete require.cache[policyPath]; delete require.cache[ctrlPath]
    try {
        const { getReservationSession: g } = require('../controllers/reservationController.js')
        assert.equal(g('11:00', '12:30').valid, true); assert.equal(g('08:00', '17:00').valid, true); assert.equal(g('07:15', '19:45').valid, true)
        const policy = require('../config/reservationPolicy.js'); assert.equal('blockCrossNoon' in policy, false); assert.equal('sessionBoundary' in policy, false)
    } finally { delete process.env.CLMS_BLOCK_CROSS_NOON; delete require.cache[policyPath]; delete require.cache[ctrlPath] }
})

test('reservation decision undo eligibility is limited to manual approve/decline decisions (no time limit)', () => {
    const { canUndoReservationDecision } = require('../controllers/reservationController.js')
    assert.equal(canUndoReservationDecision('APPROVED', '2026-10-27 10:00:00', 30), true)
    assert.equal(canUndoReservationDecision('DECLINED', '2026-10-27 10:00:00', 600), true)
    assert.equal(canUndoReservationDecision('PENDING', '2026-10-27 10:00:00', 30), false)
    assert.equal(canUndoReservationDecision('DECLINED', null, 30), false)
    assert.equal(canUndoReservationDecision('APPROVED', '2026-10-27 10:00:00', 601), true, 'no 10-minute limit')
    assert.equal(canUndoReservationDecision('APPROVED', '2026-10-27 10:00:00', 86400 * 30), true, 'still undoable after 30 days')
    assert.equal(canUndoReservationDecision('APPROVED', '2026-10-27 10:00:00', -1), false)
})

test('reservation times must align to the configured laboratory booking interval', () => {
    const { isTimeAlignedToInterval } = require('../controllers/reservationController.js')
    assert.equal(isTimeAlignedToInterval('08:00', '09:00', '08:00', 60), true)
    assert.equal(isTimeAlignedToInterval('08:30', '09:30', '08:00', 30), true)
    assert.equal(isTimeAlignedToInterval('08:15', '09:15', '08:00', 30), false)
    assert.equal(isTimeAlignedToInterval('07:00', '08:00', '08:00', 60), false)
    assert.equal(isTimeAlignedToInterval('08:00', '08:00', '08:00', 60), false)
})
