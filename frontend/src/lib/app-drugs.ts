// Limit the App catalogue for the mazdutide demo; keep the full evidence catalogue intact.
export function isAppDrug(drug: { name: string; status: string }) {
  return drug.status === 'published' && /^玛仕度肽(?:注射液)?$/.test(drug.name.trim())
}
