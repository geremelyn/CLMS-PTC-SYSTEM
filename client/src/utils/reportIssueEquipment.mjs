// CP61: Report Issue -> Equipment Type / Specific Equipment dropdown helpers. They only filter the REAL equipment records
// already loaded from GET /equipment; the server (POST /maintenance) re-validates the chosen equipment ID, laboratory and type.
const norm = value => String(value ?? '').trim().toLocaleLowerCase()
const labOf = item => item?.laboratory_id ?? item?.effective_laboratory_id
export const equipmentInLaboratory = (equipment = [], laboratoryId) => laboratoryId ? equipment.filter(item => Number(labOf(item)) === Number(laboratoryId)) : []
// Distinct registered types, one entry per type (case-insensitive), alphabetical.
export function equipmentTypesForLaboratory(equipment = [], laboratoryId) {
  const seen = new Map()
  for (const item of equipmentInLaboratory(equipment, laboratoryId)) { const type = String(item.equipment_type ?? '').trim(); if (type && !seen.has(norm(type))) seen.set(norm(type), type) }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}
export function equipmentForType(equipment = [], laboratoryId, type) {
  if (!norm(type)) return []
  return equipmentInLaboratory(equipment, laboratoryId).filter(item => norm(item.equipment_type) === norm(type))
}
export function equipmentOptionLabel(item) {
  const identity = [item.asset_tag, item.brand, item.model].filter(Boolean).join(' · ')
  return [item.equipment_type, identity].filter(Boolean).join(' — ')
}
// True only when the chosen ID is one of the records that match the selected laboratory AND type.
export function isValidEquipmentSelection(equipment, laboratoryId, type, equipmentId) {
  return Boolean(equipmentId) && equipmentForType(equipment, laboratoryId, type).some(item => String(item.id) === String(equipmentId))
}
