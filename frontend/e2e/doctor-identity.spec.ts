import { test, expect } from '@playwright/test'

test.use({ storageState: 'test-results/.auth/admin.json' })

const candidates = [
  { name: '同名测试医生', hospital: '甲测试医院', department: '神经外科', source_url: 'https://example.org/doctor-a' },
  { name: '同名测试医生', hospital: '乙测试医院', department: '消化内科', source_url: 'https://example.org/doctor-b' },
]
const choice = {
  id: 'identity-choice', kind: 'doctor', query: '同名测试医生', status: 'needs_selection',
  created_at: '2026-11-06T08:00:00Z', error: '', source_ids: [], changes: [],
  result: { findings: [], further_checks: [], doctor_candidates: candidates },
}

for (const entry of ['research', 'generator'] as const) test(`${entry}: choose identity before detailed research and keep choices after an error`, async ({ page }) => {
  let jobs: object[] = entry === 'research' ? [choice] : []
  let attempts = 0
  let requestBody: unknown
  await page.route('**/api/research', route => route.fulfill({ json: { configured: true, profiles: [{ kind: 'doctor', label: '医生公开资料检索' }], jobs, sources: [], watches: [] } }))
  await page.route('**/api/research/jobs', async route => {
    expect(route.request().postDataJSON()).toEqual({ kind: 'doctor', query: '同名测试医生' })
    jobs = [choice]
    await route.fulfill({ status: 201, json: choice })
  })
  await page.route('**/api/research/doctor-jobs', async route => {
    attempts++
    requestBody = route.request().postDataJSON()
    if (attempts === 1) return route.fulfill({ status: 503, json: { detail: '测试：暂时无法继续检索，请重试。' } })
    const next = { ...choice, id: 'selected-identity', status: 'running', query: '同名测试医生 乙测试医院 消化内科', doctor_identity: requestBody, result: null }
    jobs = [next, choice]
    await route.fulfill({ status: 201, json: next })
  })
  await page.route('**/api/research/jobs/selected-identity', route => route.fulfill({ json: jobs[0] }))
  if (entry === 'research') {
    await page.goto('/admin#admin?section=doctor')
    await page.getByRole('button', { name: '资料检索与研究记录' }).click()
  } else {
    await page.goto('/admin#workspace?tab=doctor')
    await page.getByLabel('医生姓名', { exact: true }).fill('同名测试医生')
    await page.getByRole('button', { name: '查找医生', exact: true }).click()
  }
  const selection = page.getByRole('region', { name: '同名医生选择' })
  await expect(selection).toBeVisible()
  await expect(selection.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '创建待审核医生草稿' })).toHaveCount(0)
  await expect(selection.getByRole('link', { name: '查看候选来源' }).nth(1)).toHaveAttribute('href', candidates[1].source_url)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await selection.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: test.info().outputPath(`doctor-identity-${entry}-${width}.png`), fullPage: true })
  }
  const choose = selection.getByRole('listitem').filter({ hasText: '乙测试医院' }).getByRole('button', { name: '选择并继续检索' })
  await choose.click()
  await expect(page.getByText('测试：暂时无法继续检索，请重试。', { exact: true })).toBeVisible()
  await expect(selection).toBeVisible()
  await choose.click()
  await expect(selection).toHaveCount(0)
  expect(requestBody).toEqual({ name: '同名测试医生', hospital: '乙测试医院', department: '消化内科' })
  expect(attempts).toBe(2)
  await expect(page.getByText('同名测试医生 乙测试医院 消化内科', { exact: entry === 'research' })).toBeVisible()
})
