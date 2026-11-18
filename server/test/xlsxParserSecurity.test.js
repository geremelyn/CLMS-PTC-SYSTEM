'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { parseXlsx, crc32, MAX_ENTRY_BYTES, MAX_WORKSHEET_ROWS, MAX_WORKSHEET_COLUMNS } = require('../utils/xlsxParser.js')

function makeZip(entries) {
  const locals = []
  const centrals = []
  let localOffset = 0
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name)
    const raw = Buffer.from(text)
    const compressed = zlib.deflateRawSync(raw)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(localOffset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)
    localOffset += local.length + compressed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
function workbookWithSheet(sheetXml) {
  return makeZip([
    ['xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Computers Template" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml]
  ])
}

test('rejects XLSX ZIP entries that exceed the expanded entry safety limit', () => {
  const oversized = 'x'.repeat(MAX_ENTRY_BYTES + 1)
  assert.throws(() => parseXlsx(makeZip([['xl/sharedStrings.xml', oversized]])), /expanded-size limit/i)
})

test('rejects worksheet row coordinates beyond the supported allocation limit', () => {
  const xml = `<worksheet><sheetData><row r="${MAX_WORKSHEET_ROWS + 1}"><c r="A${MAX_WORKSHEET_ROWS + 1}" t="inlineStr"><is><t>Bad</t></is></c></row></sheetData></worksheet>`
  assert.throws(() => parseXlsx(workbookWithSheet(xml)), /Worksheet row exceeds/i)
})

test('rejects worksheet columns beyond the supported allocation limit', () => {
  // BM is column 65 (zero-based index 64), beyond the 64-column parser limit.
  const xml = `<worksheet><sheetData><row r="1"><c r="BM1" t="inlineStr"><is><t>Bad</t></is></c></row></sheetData></worksheet>`
  assert.throws(() => parseXlsx(workbookWithSheet(xml)), /Worksheet column exceeds/i)
})

test('fills sparse worksheet row indexes rather than returning holes', () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Value</t></is></c></row></sheetData></worksheet>'
  const sheets = parseXlsx(workbookWithSheet(xml))
  assert.deepEqual(sheets['Computers Template'], [['Header'], [], ['Value']])
})


test('rejects workbook entries with a mismatched ZIP CRC', () => {
  const buffer = workbookWithSheet('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row></sheetData></worksheet>')
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.notEqual(central, -1)
  buffer.writeUInt32LE(0x12345678, central + 16)
  assert.throws(() => parseXlsx(buffer), /ZIP integrity check/i)
})
