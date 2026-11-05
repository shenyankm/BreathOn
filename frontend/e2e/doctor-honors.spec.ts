import { test, expect } from '@playwright/test'

test.use({ storageState:'test-results/.auth/admin.json' })

test('doctor honors can be edited, saved, displayed and removed', async ({ page }) => {
  const created = await page.request.post('/api/catalog/doctor', {
    headers:{ Origin:'http://127.0.0.1:5187' },
    data:{name:'荣誉字段测试医生', specialty:'测试科室', population:'测试人群', focus:'测试关注点',
      training_style:'测试交流方式', opening:'测试开场白'},
  })
  expect(created.ok()).toBeTruthy()
  const doctor = await created.json()
  await page.goto(`/admin#workspace?tab=doctor&doctor=${doctor.id}`)
  const form = page.getByRole('form', { name:'医生资料' })
  await expect(form.getByLabel('医生姓名')).toHaveValue(doctor.name)
  await page.screenshot({ path:'test-results/doctor-honors-before.png', fullPage:true })
  await form.getByRole('button', { name:'添加荣誉', exact:true }).click()
  const honor = form.getByRole('group', { name:'荣誉 1', exact:true })
  await honor.getByLabel('荣誉名称', { exact:true }).fill('合成教学奖')
  await honor.getByLabel('授予机构', { exact:true }).fill('测试机构')
  await honor.getByLabel('获得年份（可选）', { exact:true }).fill('2025')
  await honor.getByLabel('来源链接', { exact:true }).fill('https://example.org/honor')
  await honor.getByLabel('原文依据', { exact:true }).fill('2025 年测试机构授予荣誉字段测试医生合成教学奖。')
  for (const [width, height, label] of [[1440,1000,'desktop'], [390,844,'mobile'], [1024,768,'tablet']] as const) {
    await page.setViewportSize({ width, height })
    await page.screenshot({ path:`test-results/doctor-honors-${label}.png`, fullPage:true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await page.screenshot({ path:'test-results/doctor-honors-large-text.png', fullPage:true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/catalog/doctor/${doctor.id}`) && response.request().method() === 'PUT')
  await form.getByRole('button', { name:'保存修改', exact:true }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  expect((await response.json()).honors[0].name).toBe('合成教学奖')
  await page.reload()
  await expect(form.getByLabel('荣誉名称', { exact:true })).toHaveValue('合成教学奖')
  await page.goto('/admin#admin?section=doctor')
  await page.getByRole('button', { name:new RegExp(doctor.name) }).click()
  const detail = page.getByRole('region', { name:'医生画像详情' })
  await expect(detail.getByText('合成教学奖', { exact:true })).toBeVisible()
  await expect(detail.getByRole('link', { name:'核对荣誉来源' })).toHaveAttribute('href', 'https://example.org/honor')
  await page.goto(`/admin#workspace?tab=doctor&doctor=${doctor.id}`)
  await form.getByRole('button', { name:'移除荣誉 1', exact:true }).click()
  const removed = page.waitForResponse(response => response.url().endsWith(`/api/catalog/doctor/${doctor.id}`) && response.request().method() === 'PUT')
  await form.getByRole('button', { name:'保存修改', exact:true }).click()
  expect((await (await removed).json()).honors).toEqual([])
})
