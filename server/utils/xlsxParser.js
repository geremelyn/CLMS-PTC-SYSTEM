'use strict'
const zlib = require('node:zlib')

// XLSX is a ZIP container. Bound expanded size and worksheet coordinates so a
// small upload cannot expand into an unbounded allocation or decompression job.
const MAX_ZIP_ENTRIES = 256
const MAX_ENTRY_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
const MAX_WORKSHEET_ROWS = 2002 // header + at most 2,000 records, with a small offset allowance
const MAX_WORKSHEET_COLUMNS = 64

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function decodeXml(value) {
  return String(value ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}
function attributes(source) {
  const result = {}
  for (const match of source.matchAll(/([\w:.-]+)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2])
  return result
}
function zipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('This file is not a valid .xlsx ZIP workbook.')
  let eocd = -1
  const minimum = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= minimum; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('The workbook ZIP directory is missing or corrupt.')
  if (eocd + 22 > buffer.length) throw new Error('The workbook ZIP directory is truncated.')
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const directoryDisk = buffer.readUInt16LE(eocd + 6)
  const diskCount = buffer.readUInt16LE(eocd + 8)
  const count = buffer.readUInt16LE(eocd + 10)
  const directoryBytes = buffer.readUInt32LE(eocd + 12)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (diskNumber !== 0 || directoryDisk !== 0 || diskCount !== count || count === 0xffff || directoryBytes === 0xffffffff || offset === 0xffffffff) {
    throw new Error('Multi-disk and ZIP64 workbooks are not supported.')
  }
  if (count > MAX_ZIP_ENTRIES) throw new Error(`The workbook contains too many ZIP entries (maximum ${MAX_ZIP_ENTRIES}).`)
  if (offset + directoryBytes > eocd || offset + directoryBytes < offset) throw new Error('The workbook ZIP directory is corrupt.')
  const directoryEnd = offset + directoryBytes
  const entries = new Map()
  let totalExpandedBytes = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook ZIP directory is corrupt.')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const expandedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength
    if (recordEnd > directoryEnd || recordEnd < offset) throw new Error('The workbook ZIP directory is corrupt.')
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (!name || entries.has(name)) throw new Error('The workbook ZIP directory contains an empty or duplicate entry name.')
    if ((flags & 0x1) !== 0) throw new Error('Encrypted Excel workbooks are not supported.')
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 workbooks are not supported.')
    if (expandedSize > MAX_ENTRY_BYTES) throw new Error(`Workbook entry ${name} exceeds the ${MAX_ENTRY_BYTES / (1024 * 1024)} MB expanded-size limit.`)
    totalExpandedBytes += expandedSize
    if (totalExpandedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error(`The workbook expands beyond the ${MAX_TOTAL_UNCOMPRESSED_BYTES / (1024 * 1024)} MB safety limit.`)
    if (localOffset + 30 > offset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Workbook entry ${name} is corrupt.`)
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')
    if (localFlags !== flags || localMethod !== method || localName !== name || dataEnd > offset || dataEnd < dataStart) throw new Error(`Workbook entry ${name} has inconsistent or out-of-bounds ZIP metadata.`)
    const compressed = buffer.subarray(dataStart, dataEnd)
    let contents
    try {
      if (method === 0) contents = compressed
      else if (method === 8) contents = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
      else throw new Error(`Workbook uses unsupported ZIP compression method ${method}.`)
    } catch (error) {
      if (error.message?.includes('unsupported ZIP compression')) throw error
      throw new Error(`Workbook entry ${name} is corrupt or exceeds the decompression limit.`)
    }
    if (contents.length !== expandedSize) throw new Error(`Workbook entry ${name} has an invalid expanded size.`)
    if (crc32(contents) !== expectedCrc) throw new Error(`Workbook entry ${name} failed its ZIP integrity check.`)
    entries.set(name, contents.toString('utf8'))
    offset = recordEnd
  }
  if (offset !== directoryEnd) throw new Error('The workbook ZIP directory has unexpected trailing data.')
  return entries
}
function tagText(xml, tag) { const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')) : '' }
function colIndex(reference) { const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A'; let value = 0; for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64; return value - 1 }
function parseSheet(xml, sharedStrings) {
  const matrix = []
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttributes = attributes(rowMatch[1]); const declaredRow = Number(rowAttributes.r || matrix.length + 1); const rowIndex = Math.max(0, declaredRow - 1)
    if (!Number.isSafeInteger(declaredRow) || declaredRow < 1 || rowIndex >= MAX_WORKSHEET_ROWS) throw new Error(`Worksheet row exceeds the supported limit of ${MAX_WORKSHEET_ROWS}.`)
    const row = matrix[rowIndex] || []
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = attributes(cellMatch[1]); const body = cellMatch[2] || ''; const idx = colIndex(attr.r)
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= MAX_WORKSHEET_COLUMNS) throw new Error(`Worksheet column exceeds the supported limit of ${MAX_WORKSHEET_COLUMNS}.`)
      let value = ''
      if (attr.t === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('')
      else { const raw = tagText(body, 'v'); if (attr.t === 's' && raw !== '') value = sharedStrings[Number(raw)] ?? ''; else if (attr.t === 'b') value = raw === '1'; else value = raw }
      row[idx] = value
    }
    matrix[rowIndex] = row
  }
  return Array.from({ length: matrix.length }, (_, index) => matrix[index] || [])
}
function parseXlsx(buffer) {
  const entries = zipEntries(buffer)
  const sharedStrings = []
  const sharedXml = entries.get('xl/sharedStrings.xml')
  if (sharedXml) for (const item of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) sharedStrings.push([...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''))
  const workbook = entries.get('xl/workbook.xml')
  const rels = entries.get('xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) throw new Error('The workbook is missing its worksheet directory.')
  const targets = {}
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) { const attr = attributes(match[1]); targets[attr.Id] = attr.Target }
  const sheets = {}
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const attr = attributes(match[1]); const target = targets[attr['r:id']]
    if (!target) continue
    const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    const xml = entries.get(normalized) || entries.get(`xl/${target.replace(/^worksheets\//, 'worksheets/')}`)
    if (xml) sheets[attr.name] = parseSheet(xml, sharedStrings)
  }
  return sheets
}
module.exports = { parseXlsx, zipEntries, crc32, MAX_ZIP_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES, MAX_WORKSHEET_ROWS, MAX_WORKSHEET_COLUMNS }
