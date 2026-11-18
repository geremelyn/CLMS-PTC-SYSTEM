'use strict'
// Downloadable Excel IMPORT TEMPLATES for Users, Laboratories, Computers and Equipment.
// The column headers below are the canonical names of the REAL import field maps (excelImportValidation.js /
// simpleImportRows.js); server/test/importTemplates.test.js proves every header maps to a real import field and that the
// example rows pass the real validators. Nothing here changes the import logic or the database.
const { buildWorkbook } = require('./xlsxMultiSheet.js')
const asset = require('./excelImportValidation.js')
const simple = require('./simpleImportRows.js')

// header = column title users see; field = import field it maps to; required = the importer rejects the row without it.
const SPECS = {
  users: {
    title: 'User Accounts', fileName: 'CLMS_Users_Import_Template.xlsx', dataSheet: 'Users Template', readBy: 'first sheet',
    columns: [
      { header: 'ID Number', field: 'username', required: true, note: 'Login ID, max 50 characters. Must not already exist.', example: 'EXAMPLE-0001' },
      { header: 'Surname', field: 'surname', required: true, note: 'Last name.', example: 'EXAMPLE' },
      { header: 'First Name', field: 'first_name', required: true, note: 'Given name.', example: 'Sample' },
      { header: 'MI', field: 'middle_initial', required: false, note: 'Middle initial (optional).', example: 'S' },
      { header: 'Program', field: 'program', required: false, note: 'BSIT, BSOA, or any other program name (custom program, e.g. BSCS - type the actual name, max 100 characters, not the word Others). Required when Role is Teacher (or use BSIT-Teacher / BSOA-Teacher in Role). Not used for Dean or MIS Staff.', example: 'BSIT' },
      { header: 'Role', field: 'role', required: true, note: 'Teacher, Dean or MIS Staff. Any other text becomes a custom (Others) role label and the account is created inactive-by-role.', example: 'Teacher' },
      { header: 'Password', field: 'password', required: false, note: 'Optional. If blank the ID Number is used as the first password (it must then be at least 6 characters). Imported users must change it at first sign-in.', example: '' }
    ]
  },
  laboratories: {
    title: 'Laboratories', fileName: 'CLMS_Laboratories_Import_Template.xlsx', dataSheet: 'Laboratories Template', readBy: 'first sheet',
    columns: [
      { header: 'Laboratory Name', field: 'laboratory_name', required: true, note: 'Must not already exist.', example: 'EXAMPLE Laboratory' },
      { header: 'Capacity', field: 'capacity', required: true, note: 'Positive whole number of computers.', example: 30 },
      { header: 'Status', field: 'status', required: false, note: 'OPEN, USED or UNAVAILABLE. Any other text is treated as a custom status.', example: 'OPEN' },
      { header: 'Status Other', field: 'status_other', required: false, note: 'Optional custom status text (used when Status is not OPEN/USED/UNAVAILABLE).', example: '' },
      { header: 'Available From', field: 'available_from', required: false, note: 'Opening time HH:MM. Give both From and Until or neither. Blank = 07:00.', example: '07:00' },
      { header: 'Available Until', field: 'available_until', required: false, note: 'Closing time HH:MM. Blank = 21:00.', example: '21:00' },
      { header: 'Reason', field: 'reason', required: false, note: 'Optional note.', example: '' }
    ]
  },
  computers: {
    title: 'Computers', fileName: 'CLMS_Computers_Import_Template.xlsx', dataSheet: 'Computers Template', readBy: 'sheet named "Computers Template"',
    columns: [
      { header: 'Computer Name', field: 'computer_name', required: true, note: 'Name shown in CLMS.', example: 'EXAMPLE-PC-01' },
      { header: 'Laboratory ID', field: 'laboratory_id', required: true, note: 'ID of an existing laboratory (shown in the Laboratories page). The laboratory must not be at capacity.', example: 1 },
      { header: 'Asset Tag', field: 'asset_tag', required: true, note: 'Unique across computers AND equipment.', example: 'EXAMPLE-TAG-001' },
      { header: 'Serial Number', field: 'serial_number', required: true, note: 'Unique across computers AND equipment.', example: 'EXAMPLE-SN-001' },
      { header: 'Processor', field: 'processor', required: true, note: 'For example Intel Core i5.', example: 'Intel Core i5' },
      { header: 'RAM', field: 'ram', required: true, note: 'Whole number of GB (8 or 8 GB).', example: 8 },
      { header: 'Storage Capacity', field: 'storage_capacity', required: true, note: 'Positive whole number.', example: 256 },
      { header: 'Storage Unit', field: 'storage_unit', required: true, note: 'GB or TB (or a custom option already added in CLMS).', example: 'GB' },
      { header: 'Storage Type', field: 'storage_type', required: true, note: 'HDD or SSD (or a custom option already added in CLMS).', example: 'SSD' },
      { header: 'Operational Status', field: 'operational_status', required: true, note: 'ACTIVE or INACTIVE (or a custom option already added in CLMS).', example: 'ACTIVE' },
      { header: 'Condition', field: 'condition', required: true, note: 'WORKING, UNDER REPAIR, DAMAGED, MISSING or RETIRED (or a custom option).', example: 'WORKING' },
      { header: 'Condition Note', field: 'condition_note', required: false, note: 'Required when Condition is not WORKING.', example: '' }
    ]
  },
  equipment: {
    title: 'Equipments', fileName: 'CLMS_Equipments_Import_Template.xlsx', dataSheet: 'Equipment Template', readBy: 'sheet named "Equipment Template"',
    columns: [
      { header: 'Equipment Type', field: 'equipment_type', required: true, note: 'For example Projector, Monitor, Router.', example: 'Projector' },
      { header: 'Laboratory ID', field: 'laboratory_id', required: true, note: 'ID of an existing laboratory.', example: 1 },
      { header: 'Computer Assignment (ID or exact computer name)', field: 'computer_id', required: false, note: 'Optional. A computer ID or exact computer name that belongs to the same laboratory.', example: '' },
      { header: 'Asset Tag', field: 'asset_tag', required: true, note: 'Unique across computers AND equipment.', example: 'EXAMPLE-EQ-001' },
      { header: 'Serial Number', field: 'serial_number', required: true, note: 'Unique across computers AND equipment.', example: 'EXAMPLE-EQ-SN-001' },
      { header: 'Brand', field: 'brand', required: false, note: 'Optional.', example: 'ExampleBrand' },
      { header: 'Model', field: 'model', required: false, note: 'Optional.', example: 'ExampleModel' },
      { header: 'Status', field: 'equipment_state', required: false, note: 'ACTIVE or INACTIVE, or a custom status (Others) already saved on the Equipment page. Optional: leave blank (or omit the column) for ACTIVE. Separate from Condition.', example: 'ACTIVE' },
      { header: 'Condition', field: 'status', required: true, note: 'WORKING or NOT WORKING (or a custom condition saved on the Equipment page). Separate from Status.', example: 'WORKING' },
      { header: 'Condition Note', field: 'condition_note', required: false, note: 'Required when Condition is not WORKING.', example: '' }
    ]
  }
}
const FIELD_MAPS = { users: simple.FIELDS.users, laboratories: simple.FIELDS.laboratories, computers: asset.COMPUTER_FIELDS, equipment: asset.EQUIPMENT_FIELDS }
const keyOf = simple.headerKey

function buildTemplate(type) {
  const spec = SPECS[type]; if (!spec) throw new Error('Unknown template type.')
  const headers = spec.columns.map(c => c.header)
  const widths = headers.map(h => Math.max(14, Math.min(46, h.length + 4)))
  const instructions = [
    [`CLMS — ${spec.title} Excel Import Template`],
    [],
    ['HOW TO USE'],
    [`1. Fill in the first sheet ("${spec.dataSheet}"). Keep the header row exactly as it is, and type one record per row starting directly below it.`],
    ['2. The importer ignores the "Examples" sheet and this "Instructions" sheet. Do not rely on them for data.'],
    ['3. In CLMS use File Actions → Import Excel, choose this file, review the preview, then confirm. Nothing is saved until you confirm; if any row has an error nothing is saved.'],
    [`4. Read by the importer: ${spec.readBy}. Maximum 2,000 rows and 5 MB per file. Only .xlsx files are accepted.`],
    [],
    ['COLUMNS'],
    ['Column', 'Required?', 'Notes'],
    ...spec.columns.map(c => [c.header, c.required ? 'Required' : 'Optional', c.note])
  ]
  const examples = [
    ['EXAMPLES ONLY — THIS SHEET IS NOT IMPORTED. Copy the layout to the first sheet and replace every value with your real data.'],
    headers,
    spec.columns.map(c => c.example)
  ]
  return buildWorkbook([
    { name: spec.dataSheet, rows: [headers], widths, boldRows: [1] },
    { name: 'Instructions', rows: instructions, widths: [48, 12, 90], boldRows: [1, 3, 9, 10], wrap: true },
    { name: 'Examples (not imported)', rows: examples, widths, boldRows: [1, 2] }
  ])
}
module.exports = { SPECS, FIELD_MAPS, buildTemplate, keyOf }
