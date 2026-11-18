const test = require('node:test')
const assert = require('node:assert/strict')
const { validateManagedUser, validManagedUserId } = require('../utils/userValidation.js')

test('normalizes managed user names and validates teacher program', () => {
  const valid = validateManagedUser({ full_name: ' Alex User ', username: ' 2026001 ', password: 'secure12', role: 'Teacher', program: 'BSIT' }, { passwordRequired: true })
  assert.equal(valid.error, null)
  assert.deepEqual(valid.values, { full_name: 'Alex User', username: '2026001', password: 'secure12', role: 'Teacher', program: 'BSIT', role_other: null, labelOnly: false, surname: null, first_name: null, middle_initial: null })
  assert.match(validateManagedUser({ full_name: 'Alex', username: '2026001', password: 'secure12', role: 'Teacher' }, { passwordRequired: true }).error, /select a Program \(BSIT, BSOA or Others\)/i)
})
test('rejects missing, oversized, short-password, and unsupported role fields', () => {
  assert.match(validateManagedUser({ full_name: ' ', username: 'x', password: 'secure12', role: 'Dean' }, { passwordRequired: true }).error, /required/i)
  assert.match(validateManagedUser({ full_name: 'x'.repeat(101), username: 'x', password: 'secure12', role: 'Dean' }, { passwordRequired: true }).error, /100 characters/i)
  assert.match(validateManagedUser({ full_name: 'Alex', username: 'x'.repeat(51), password: 'secure12', role: 'Dean' }, { passwordRequired: true }).error, /50 characters/i)
  assert.match(validateManagedUser({ full_name: 'Alex', username: 'id', password: '123', role: 'Dean' }, { passwordRequired: true }).error, /at least 6/i)
  assert.match(validateManagedUser({ full_name: 'Alex', username: 'id', role: 'MIS' }).error, /invalid role/i)
})
test('validates user identifiers while preserving legacy ID zero', () => {
  assert.equal(validManagedUserId('0', { allowZero: true }), true)
  assert.equal(validManagedUserId('0'), false)
  assert.equal(validManagedUserId('12'), true)
  for (const id of ['', '-1', '1.5', '1x', '9007199254740992']) assert.equal(validManagedUserId(id, { allowZero: true }), false)
})

test('Others role is a display label: requires text, never a managed role', () => {
  const { validateManagedUser } = require('../utils/userValidation.js')
  const ok = validateManagedUser({ full_name: 'Pat Guest', username: 'G1', password: 'secure12', role: 'Others', role_other: ' Librarian ' }, { passwordRequired: true })
  assert.equal(ok.error, null); assert.equal(ok.values.role_other, 'Librarian'); assert.equal(ok.values.labelOnly, true); assert.equal(ok.values.program, null); assert.equal(ok.values.role, 'Others', 'Others must NOT be stored as Teacher')
  assert.ok(validateManagedUser({ full_name: 'Pat', username: 'G1', password: 'secure12', role: 'Others', role_other: '' }, { passwordRequired: true }).error)
  assert.ok(validateManagedUser({ full_name: 'Pat', username: 'G1', password: 'secure12', role: 'MIS' }, { passwordRequired: true }).error, 'MIS still cannot be created')
})

test('name parts compose the stored full name', () => {
  const { validateManagedUser } = require('../utils/userValidation.js')
  const r = validateManagedUser({ surname: 'Dela Cruz', first_name: 'Juan', middle_initial: 'p.', username: 'T9', role: 'Dean' })
  assert.equal(r.error, null); assert.equal(r.values.full_name, 'Juan P. Dela Cruz'); assert.equal(r.values.middle_initial, 'P')
})

test('SECURITY: Others may appear ONLY on self-service and lab-reservation routes (CP68); never elsewhere; no unrestricted requireRole()', () => {
  const fs = require('node:fs'), path = require('node:path')
  const dir = path.resolve(__dirname, '../routes')
  const found = []
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.ok(!/requireRole\(\s*\)/.test(src), `${file} has an unrestricted requireRole()`)
    for (const line of src.split('\n')) if (/requireRole\([^)]*Others/.test(line)) found.push(`${file}: ${(line.match(/router\.\w+\('([^']+)'/) || [])[0] || line.trim()}`)
  }
  // CP123: custom roles also use the own-only Teacher Schedule routes (own-only is enforced in teacherScheduleController); CP128 added DELETE /:id and the inline /:id/view route is part of the same own-only access.
  // CP68: custom roles also get the Teacher-style lab reservation routes; the exact list is asserted in customRolePermissionsCp68.test.js.
  assert.deepEqual(found.sort(), ["authRoutes.js: router.post('/logout'", "computerRoutes.js: router.get('/'", "equipmentRoutes.js: router.get('/'", "holidayRoutes.js: router.get('/'", "laboratoryRoutes.js: router.get('/'", "maintenanceRoutes.js: router.post('/'", "reportRoutes.js: router.get('/maintenance'", "reservationRoutes.js: router.get('/'", "reservationRoutes.js: router.get('/availability'", "reservationRoutes.js: router.post('/'", "reservationRoutes.js: router.put('/:id/cancel'", "reservationRoutes.js: router.put('/:id/cancel-own'", "reservationRoutes.js: router.put('/:id/undo-cancel'", "reservationRoutes.js: router.put('/:id/undo-create'", "teacherScheduleRoutes.js: router.delete('/:id'", "teacherScheduleRoutes.js: router.get('/'", "teacherScheduleRoutes.js: router.get('/:id/download'", "teacherScheduleRoutes.js: router.get('/:id/view'", "teacherScheduleRoutes.js: router.post('/'", "teacherScheduleRoutes.js: router.post('/:id/undo-upload'", "userRoutes.js: router.put('/:id/change-password'"])
  // The change-password route must still refuse any id other than the caller's own.
  const route = fs.readFileSync(path.join(dir, 'userRoutes.js'), 'utf8')
  assert.match(route, /You may only change your own password/)
})

// CP166 Part 7 - regression: a built-in program typed under "Others" in any case is stored in its canonical spelling (pure validator, no DB).
test('CP166 Part 7: Teacher program "Others" + "bsit"/"BsOa" is stored as BSIT/BSOA; real custom programs keep their spelling', () => {
  const { validateManagedUser } = require('../utils/userValidation.js')
  const base = { surname: 'Cruz', first_name: 'Ana', username: 't1', password: 'Passw0rd!x', role: 'Teacher', program: 'Others' }
  const run = program_other => validateManagedUser({ ...base, program_other }, { passwordRequired: true })
  assert.equal(run('bsit').values.program, 'BSIT'); assert.equal(run('  BsOa ').values.program, 'BSOA')
  assert.equal(run('BSCS  Major').values.program, 'BSCS Major'); assert.equal(run('bscs').values.program, 'bscs')
  assert.match(run('others').error, /actual program name/); assert.match(run('').error, /custom program name/); assert.match(run('x'.repeat(101)).error, /100 characters/)
})
