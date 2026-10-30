import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { drugs, drugCatalogueSource, drugCatalogueCheckedAt } from '../src/lib/drugs.ts'

test('catalogue covers all 20 launched products in the dated official inventory', () => {
  const officialIds = [1, 4, 3, 16, 14, 40, 82, 83, 17, 31, 42, 107, 37, 104, 88, 30, 13, 2, 121, 122]
  assert.deepEqual(drugs.map(drug => drug.sourceId), officialIds)
  assert.equal(new Set(drugs.map(drug => drug.id)).size, 20)
  assert.equal(new Set(drugs.map(drug => drug.name)).size, 20)
  assert.equal(new Set(drugs.map(drug => drug.brand)).size, 20)
  assert.equal(drugCatalogueSource, 'https://www.innoventbio.com/#/product/products')
  assert.equal(drugCatalogueCheckedAt, '2026-10-29')
})

test('every card has a real local image, a summary and a primary document link', () => {
  const hosts = new Set(['img.innoventbio.com', 'images.qingtv.com', 'www.lillymedical.cn', 'www.daiichisankyo.com.cn'])
  for (const drug of drugs) {
    assert.ok(drug.name && drug.brand && drug.target && drug.category && drug.overview)
    const url = new URL(drug.document.url)
    assert.equal(url.protocol, 'https:')
    assert.ok(hosts.has(url.hostname), drug.name)
    const raw = readFileSync(new URL(`../src/assets/library/innovent/${drug.image}`, import.meta.url))
    assert.ok(raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || raw.subarray(0, 3).equals(Buffer.from([255, 216, 255])), drug.image)
  }
})

test('alternate document and image formats are explicitly identified', () => {
  const guide = drugs.find(drug => drug.id === 'equecabtagene')!
  assert.equal(guide.document.label, '患者手册（非说明书）')
  assert.equal(guide.document.sourceUrl, 'https://i-connection.iasobio.com/')
  const imageLabel = drugs.find(drug => drug.id === 'teprotumumab')!
  assert.equal(imageLabel.document.label, '说明书（图片）')
  assert.ok(imageLabel.document.url.endsWith('.jpg'))
  assert.equal(drugs.find(drug => drug.id === 'abemaciclib')?.imageLabel, '官方品牌标识')
  assert.equal(drugs.find(drug => drug.id === 'quizartinib')?.imageLabel, '说明书首页（局部）')
})
