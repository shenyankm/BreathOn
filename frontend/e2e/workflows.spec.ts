import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const origin = 'http://127.0.0.1:5187'
const password = 'local-e2e-only-password'
const actors: Record<string, APIRequestContext> = {}
let content: any, doctor: any, rubric: any, scenario: any
async function call(who: string, method: string, path: string, data?: unknown) {
  const response = await actors[who].fetch(`/api${path}`, { method, data })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.json()
}
async function publish(kind: string, body: unknown) {
  const row = await call('admin', 'POST', `/catalog/${kind}`, body)
  return call('admin', 'POST', `/catalog/${kind}/${row.id}/publish`, { version: row.version })
}


async function syntheticPrices() {
  const current=await call('admin','GET','/usage/prices')
  const health=await call('admin','GET','/health')
  await call('admin','PUT','/usage/prices',{version:current.version,rates:['input_tokens','output_tokens'].map(unit=>({provider:'deepseek',model:health.analysis_model,unit,amount:'1',per_units:1000000,currency:'CNY',source_url:'https://example.org/e2e-synthetic-rate',checked_on:new Date().toISOString().slice(0,10),note:'E2E合成费率，仅验证计算，不是实际报价。'}))})
}

test.beforeAll(async () => {
  for (const name of ['admin', 'a', 'b', 'medical', 'compliance']) {
    const state = path.resolve('test-results/.auth', `${name}.json`)
    mkdirSync(path.dirname(state), { recursive: true })
    actors[name] = await request.newContext({ baseURL: origin, timeout: 60_000, extraHTTPHeaders: { Origin: origin }, ...(existsSync(state) ? { storageState: state } : {}) })
    if (!(await (await actors[name].get('/api/auth/session')).json()).authenticated) {
      await call(name, 'POST', '/auth/login', { username: `e2e-${name}`, password })
      await actors[name].storageState({ path: state })
    }
  }
  await syntheticPrices()
  content = await call('admin', 'POST', '/catalog/content', { title: 'E2E 合成资料', version_label: 'test-v1',
    scope: '仅供软件流程测试，不是医学证据。', pages: [{ number: 1, text: '合成教学资料：交流时先确认需求，再核对原文范围，不作个体效果保证。' }] })
  for (const action of ['submit', 'approve']) content = await call('admin', 'POST', `/catalog/content/${content.id}/review`, { version: content.version, action, reason: '仅核对合成测试资料，不代表医学审核。' })
  doctor = await publish('doctor', { name: 'E2E虚构医生', specialty: '内分泌科', background_type: 'fictional',
    population: '虚构测试情境', focus: '需求、证据范围与沟通边界', training_style: '每轮一个问题，不虚构医学结论。', mood: 'neutral', opening: '你好，今天想交流什么？' })
  rubric = await publish('rubric', { name: 'E2E沟通量表', dimensions: [{ key: 'communication', label: '沟通结构', weight: 100,
    requires_content: false, anchors: ['未回应', '不清楚', '部分回应', '结构清楚', '确认需求并清楚回应'] }] })
  scenario = await publish('scenario', { title: 'E2E合成场景', product: '合成教学主题', disease: '软件测试',
    objective: '确认交流需求，说明待核实边界。', doctor_id: doctor.id, rubric_id: rubric.id,
    content_ids: [content.id], stages: ['opening','needs','evidence','objections','safety','closing'], duration_seconds: 120, difficulty: 'basic' })
})
test.afterAll(async () => { for (const actor of Object.values(actors)) await actor.dispose() })

test('anonymous and representative authorization boundaries use the real server', async () => {
  const anonymous = await request.newContext({ baseURL: origin })
  try {
    for (const path of ['/api/sessions','/api/catalog/drug','/api/admin/settings']) expect((await anonymous.get(path)).status()).toBe(401)
    expect((await anonymous.get('/app')).status()).toBe(410)
    expect((await anonymous.get('/_android/index.html')).status()).toBe(404)
    expect((await actors.a.get('/api/admin/settings')).status()).toBe(403)
    expect((await actors.a.post('/api/catalog/doctor', { data: {} })).status()).toBe(403)
  } finally { await anonymous.dispose() }
})

test('real browser login, every admin section and training tool render without JS errors', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/admin')
  await page.locator('input[name="username"]').fill('e2e-admin')
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '管理后台', exact: true })).toBeVisible()
  for (const section of ['drug','doctor','audiences','policy','training','review','records','settings']) {
    await page.goto(`/admin#admin?section=${section}`)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByText('正在加载管理内容…')).toHaveCount(0)
    await expect(page.locator('main').getByRole('heading').first()).toBeVisible()
    await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  }
  for (const tab of ['scenario','doctor','content','rubric','cases','pricing','research']) {
    await page.goto(`/admin#workspace?tab=${tab}`)
    await expect(page.getByRole('heading', { name: '训练管理', exact: true })).toBeVisible()
    await expect(page.getByText('正在加载管理内容…')).toHaveCount(0)
    await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  }
  await page.screenshot({ path: test.info().outputPath('admin.png'), fullPage: true })
  expect(errors).toEqual([])
})

test('browser creates, reviews and retires a training document', async ({ page }) => {
  await page.context().addCookies((await actors.admin.storageState()).cookies)
  const title = `UI E2E 资料 ${Date.now()}`
  await page.goto('/admin#workspace?tab=content')
  await page.getByRole('button', { name: '添加训练资料', exact: true }).click()
  await page.getByLabel('资料名称', { exact: true }).fill(title)
  await page.getByLabel('资料版本', { exact: true }).fill('UI-v1')
  await page.getByLabel('适用范围', { exact: true }).fill('合成软件测试')
  await page.getByLabel('原文正文', { exact: true }).fill('合成资料用于验证真实表单保存、核对、版本和撤销闭环。')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await page.getByLabel('核对说明', { exact: true }).fill('测试资料，非医学审核。')
  await page.getByRole('button', { name: '提交核对', exact: true }).click()
  await page.getByLabel('核对说明', { exact: true }).fill('核对软件流程。')
  await page.getByRole('button', { name: '确认核对', exact: true }).click()
  await expect(page.getByRole('button', { name: '停用此版本', exact: true })).toBeVisible()
  await page.getByLabel('核对说明', { exact: true }).fill('结束测试，停用。')
  await page.getByRole('button', { name: '停用此版本', exact: true }).click()
  await expect(page.getByRole('button', { name: '停用此版本', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
})

test('catalogues, published training preview, imports and version rejection', async () => {
  for (const kind of ['drug','doctor','content','policy','policy_rule','audience','lesson','rubric','scenario']) expect(Array.isArray(await call('admin','GET',`/catalog/${kind}`))).toBeTruthy()
  const preview = await call('a','GET',`/scenarios/${scenario.id}/preview`)
  expect(preview.documents[0].id).toBe(content.id)
  const exported = await call('admin','GET',`/scenarios/${scenario.id}/export`)
  exported.scenario.title = 'E2E导入场景'
  const receipt = await call('admin','POST','/scenarios/import',exported)
  expect((await call('admin','GET',`/catalog/scenario/${receipt.scenario_id}`)).status).toBe('draft')
  expect((await call('admin','POST','/scenarios/import',exported)).scenario_id).toBe(receipt.scenario_id)
  const revised = await call('admin','POST',`/catalog/content/${content.id}/revision`)
  expect(revised.status).toBe('draft')
  expect((await actors.admin.post(`/api/catalog/content/${content.id}/review`, { data: { version: 0, action: 'retire', reason: '过时版本' } })).status()).toBe(422)
})

test('lesson plans, completion, home statistics and preferences are account scoped', async () => {
  const course = await call('a','GET','/curriculum'); const lesson = course.levels.flatMap((l: any) => l.lessons)[0]
  await call('a','PUT',`/curriculum/lessons/${lesson.id}`,{state:'planned'})
  expect((await call('a','GET','/home')).tasks.some((l: any)=>l.id===lesson.id)).toBeTruthy()
  expect((await call('b','GET','/curriculum')).plan).toEqual([])
  await call('a','PUT',`/curriculum/lessons/${lesson.id}`,{state:'completed'})
  expect((await call('a','GET','/curriculum')).levels.flatMap((l: any)=>l.lessons).find((l: any)=>l.id===lesson.id).state).toBe('completed')
  await call('a','PUT','/me/settings',{training_reminder:false})
  expect((await call('a','GET','/me/settings')).training_reminder).toBe(false)
  expect((await call('b','GET','/me/settings')).training_reminder).toBe(true)
})

test('visits: private original, redaction, submission, administrator review and reusable case', async () => {
  const row = await call('a','POST','/visits',{visited_at:new Date().toISOString().slice(0,10),source:'self_report',doctor_id:doctor.id,text:'合成拜访原话，患者张测试，电话13800138000。'})
  expect((await actors.b.get(`/api/visits/${row.id}`)).status()).toBe(404)
  expect((await actors.admin.get(`/api/visits/${row.id}`)).status()).toBe(200) // Administrator reads are explicitly authorized and audited.
  const confirmed = await call('a','POST',`/visits/${row.id}/confirm`,{version:row.version,redacted_text:'已脱敏的合成沟通：先确认问题，再核对证据。',redaction_confirmed:true,speakers:[]})
  const reviewable = await call('admin','GET',`/visits/${row.id}`)
  expect(reviewable.redacted_text).not.toContain('13800138000')
  const reviewed = await call('admin','POST',`/visits/${row.id}/review`,{version:confirmed.version,decision:'scenario',reason:'仅采纳沟通情境，不作医学事实。'})
  expect(reviewed.status).toBe('reviewed')
  const example = await call('admin','GET',`/cases/${reviewed.review.case_id}`)
  expect(example.situation).not.toContain('13800138000')
  const share = await call('admin','GET',`/cases/${example.id}/export`)
  const imported = await call('a','POST','/cases/import',share)
  expect(imported.status).toBe('draft')
  expect((await actors.b.get(`/api/cases/${imported.id}`)).status()).toBe(404)
  expect((await call('a','GET','/me/review-queue')).items.some((i: any)=>i.id===row.id)).toBeTruthy()
})

test('health observations: consent, independent review, sharing and revocation', async () => {
  const settings = await call('admin','GET','/admin/settings')
  const body = Object.fromEntries(['version','doctor_recommendation','training_scoring','health_sharing','review_rules','medical_reviewers','compliance_reviewers'].map(k=>[k,settings[k]]))
  await call('admin','PUT','/admin/settings',{...body,health_sharing:true})
  const row = await call('a','POST','/health/observations',{metric:'合成指标',value:1.2,unit:'test',observed_at:new Date(Date.now()-60000).toISOString(),conditions:'软件测试',limitations:'非设备测量，无诊断含义'})
  expect((await call('admin','GET','/admin/health/observations')).some((r: any)=>r.id===row.id)).toBe(false)
  const consent = await call('a','POST',`/health/observations/${row.id}/consent`,{version:row.version,consent:true})
  const approved = await call('admin','POST',`/admin/health/observations/${row.id}/review`,{version:consent.version,decision:'approve',reason:'验证合成授权流程'})
  expect((await call('a','GET','/health/shared')).items.some((r: any)=>r.id===row.id)).toBe(true)
  await call('a','POST',`/health/observations/${row.id}/revoke`,{version:approved.version})
  expect((await call('a','GET','/health/shared')).items.some((r: any)=>r.id===row.id)).toBe(false)
})

test('publication requires distinct assigned medical and compliance reviewers', async () => {
  const current = await call('admin','GET','/admin/settings')
  const body=Object.fromEntries(['version','doctor_recommendation','training_scoring','health_sharing','review_rules','medical_reviewers','compliance_reviewers'].map(k=>[k,current[k]]))
  await call('admin','PUT','/admin/settings',{...body,review_rules:{...current.review_rules,content:'medical_compliance'},medical_reviewers:['e2e-medical'],compliance_reviewers:['e2e-compliance']})
  try {
    let row=await call('admin','POST','/catalog/content',{title:'双人审核合成资料',version_label:'v1',scope:'软件测试',pages:[{number:1,text:'软件测试资料原文。'}]})
    row=await call('admin','POST',`/catalog/content/${row.id}/review`,{version:row.version,action:'submit',reason:'送审'})
    const state=await call('admin','GET',`/admin/catalog/content/${row.id}/approval`)
    const vote={version:row.version,settings_version:state.settings_version,decision:'approve',reason:'合成流程测试'}
    expect((await call('medical','POST',`/admin/catalog/content/${row.id}/approval`,{...vote,role:'medical'})).ready).toBe(false)
    expect((await actors.admin.post(`/api/catalog/content/${row.id}/review`,{data:{version:row.version,action:'approve',reason:'不允许绕过'}})).status()).toBe(409)
    expect((await call('compliance','POST',`/admin/catalog/content/${row.id}/approval`,{...vote,role:'compliance'})).ready).toBe(true)
    expect((await call('admin','POST',`/catalog/content/${row.id}/review`,{version:row.version,action:'approve',reason:'完成双人审核'})).status).toBe('approved')
  } finally {
    const next=await call('admin','GET','/admin/settings')
    await call('admin','PUT','/admin/settings',{...body,version:next.version})
  }
})

test('records, progress, metrics, pricing, archives and service settings have live HTTP contracts', async () => {
  for(const path of ['/sessions','/progress','/admin/sessions','/admin/audience-metrics','/usage/prices','/research','/admin/versions']) {
    const response=await actors.admin.get(`/api${path}`)
    expect(response.ok(),`${path}: ${await response.text()}`).toBeTruthy()
  }
  const prices=await call('admin','GET','/usage/prices')
  await call('admin','PUT','/usage/prices',{version:prices.version,rates:[]})
  expect((await call('admin','GET','/usage/prices')).version).toBeGreaterThan(prices.version)
  await syntheticPrices()
})

test('real providers: service checks, scenario generation and model calibration', async () => {
  test.skip(process.env.E2E_LIVE!=='1','Opt in with E2E_LIVE=1; these calls incur provider usage')
  test.setTimeout(300_000)
  const services=await call('admin','POST','/services/check')
  await test.info().attach('real-service-checks',{body:JSON.stringify(services),contentType:'application/json'})
  for(const [name,result] of Object.entries(services.services)) expect((result as any).ok, `${name}: ${JSON.stringify(result)}`).toBe(true)
  const generated=await call('admin','POST','/scenarios/generate',{product:'合成教学主题',disease:'软件测试',objective:'先确认需求，不编造医学结论。',doctor_id:doctor.id,rubric_id:rubric.id,content_ids:[content.id]})
  expect(generated.generation.usage.total_tokens).toBeGreaterThan(0)
  expect(Number(generated.generation.cost.totals.CNY)).toBeGreaterThan(0)
  const sample=await call('admin','POST','/calibration/samples',{title:'合成标注，不是专家校准',scenario_id:scenario.id,label_type:'synthetic',messages:[{id:'u',role:'trainee',text:'您好，请问您希望先交流什么问题？',final:true}],expected_scores:{communication:3}})
  expect(sample.id).toBeTruthy()
  const run=await call('admin','POST',`/rubrics/${rubric.id}/calibration`,{version:rubric.version})
  await expect.poll(async()=> (await call('admin','GET',`/calibration/runs/${run.id}`)).status,{timeout:180_000,intervals:[1000,3000]}).not.toBe('running')
  const finished=await call('admin','GET',`/calibration/runs/${run.id}`)
  await test.info().attach('real-calibration',{body:JSON.stringify(finished),contentType:'application/json'})
  expect(finished.status).toBe('completed')
  expect((await call('admin','GET',`/catalog/rubric/${rubric.id}`)).calibration_status).toBe('uncalibrated')
})

for (const experience of ['practice','combat']) test(`real providers: ${experience} speech, ASR, doctor response, final analysis and saved record`, async ({page}) => {
  test.skip(process.env.E2E_LIVE!=='1','Opt in with E2E_LIVE=1; real provider usage')
  test.setTimeout(240_000)
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const audioPath = path.resolve('test-results/synthetic-input.pcm')
  if(!existsSync(audioPath)) execFileSync('uv',['run','--directory','../backend','--locked','python','-m','tools.e2e_audio','--live','--output',audioPath],{timeout:60_000})
  const audio=readFileSync(audioPath).toString('base64')
  await page.context().addCookies((await actors.admin.storageState()).cookies)
  await page.goto('/admin')
  const exchange = (remediationId='') => page.evaluate(async ({audio,experience,scenarioId,remediationId}) => {
    const input=atob(audio); let offset=0, sending=false, inputFinishedAt=0, trainee=false, responded=false, outputBytes=0
    const events:any[]=[]
    let earlierDoctors = new Set<string>()
    function beginInput() { earlierDoctors = new Set(events.filter(e=>e.type==='transcript'&&e.role==='doctor').map(e=>e.id)); sending=true }
    return await new Promise<any>((resolve)=>{
      const ws=new WebSocket(`${location.origin.replace('http','ws')}/api/realtime?experience=${experience}&scenario_id=${scenarioId}&remediation_id=${remediationId}`)
      let interval:ReturnType<typeof setInterval>|undefined
      const timeout=setTimeout(()=>finish(new Error('Voice session did not complete within 180 seconds')),180_000)
      let stopping=false,opening=false,settled=false
      function finish(error?:Error,ended?:any) {
        if(settled)return;settled=true
        clearTimeout(timeout);clearInterval(interval);ws.close()
        resolve({events,ended,outputBytes,error:error?.message})
      }
      function stop() { if(!stopping){stopping=true;clearInterval(interval);ws.send(JSON.stringify({type:'stop'}))} }
      ws.onopen=()=>ws.send(JSON.stringify({type:'start',mode:experience==='practice'?'assisted':'independent'}))
      ws.onerror=()=>finish(new Error('WebSocket transport failed'))
      ws.onclose=event=>{if(!settled)finish(new Error(`WebSocket closed before saving: ${event.code}`))}
      ws.onmessage=({data})=>{
        const event=JSON.parse(data)
        if(event.type==='audio') outputBytes+=atob(event.audio).length
        else events.push(event)
        if(event.type==='error') return finish(new Error(`${event.code}: ${event.message}`))
        if(event.type==='ready') interval=setInterval(()=>{
          let frame='\0'.repeat(640)
          if(sending&&offset<input.length){frame=input.slice(offset,offset+640).padEnd(640,'\0');offset+=640;if(offset>=input.length)inputFinishedAt=Date.now()}
          if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'audio',audio:btoa(frame),playing:false}))
          if(experience==='combat'&&trainee&&responded&&inputFinishedAt&&Date.now()-inputFinishedAt>3000)stop()
        },20)
        if(experience==='practice'&&event.type==='tts_state'&&event.state==='done') {
          if(!opening){opening=true;beginInput()}else if(trainee&&inputFinishedAt)stop()
        }
        if(experience==='combat'&&event.type==='audio'&&!opening){opening=true;setTimeout(beginInput,4000)}
        if(event.type==='transcript'&&event.role==='trainee'&&event.final&&event.text?.trim())trainee=true
        if(event.type==='transcript'&&event.role==='doctor'&&event.final&&sending&&!earlierDoctors.has(event.id))responded=true
        if(event.type==='ended')finish(undefined,event)
      }
    })
  },{audio,experience,scenarioId:scenario.id,remediationId})
  const capture = await exchange()
  await test.info().attach(`real-${experience}-events`,{body:JSON.stringify(capture),contentType:'application/json'})
  expect(capture.error).toBeUndefined()
  expect(capture.outputBytes).toBeGreaterThan(0)
  expect(capture.ended.saved).toBe(true)
  const ready=capture.events.find((e:any)=>e.type==='ready')
  const record=await call('admin','GET',`/sessions/${ready.session_id}`)
  await test.info().attach(`real-${experience}-record`,{body:JSON.stringify(record),contentType:'application/json'})
  expect(record.capture_status).toBe('completed')
  expect(record.messages.some((m:any)=>m.role==='trainee'&&m.final&&m.text.trim())).toBe(true)
  expect(record.analysis_status).toBe('completed')
  expect(record.coaching.some((c:any)=>c.final_report)).toBe(true)
  expect(record.summary_card.version).toBe(1)
  await call('admin','POST',`/sessions/${ready.session_id}/reviews`,{comment:'E2E人工点评流程验证，非临床评价。',overrides:[]})
  expect((await call('admin','GET',`/sessions/${ready.session_id}/reviews`)).reviews.length).toBeGreaterThan(0)
  const plan=await call('admin','POST',`/sessions/${ready.session_id}/retrain`,{})
  expect((await call('admin','GET',`/remediations/${plan.id}/next`)).remediation_id).toBe(plan.id)
  const utterance=record.messages.find((m:any)=>m.role==='trainee'&&m.final)
  const example=await call('admin','POST',`/sessions/${ready.session_id}/cases`,{message_id:utterance.id})
  expect(example.quotes.some((q:any)=>q.text===utterance.text)).toBe(true)
  expect((await actors.a.get(`/api/sessions/${ready.session_id}`)).status()).toBe(404)
  if(experience==='practice') {
    const repeated=await exchange(plan.id)
    await test.info().attach('real-retraining-events',{body:JSON.stringify(repeated),contentType:'application/json'})
    expect(repeated.error).toBeUndefined()
    expect(repeated.ended.saved).toBe(true)
    const progress=await call('admin','GET',`/remediations/${plan.id}/progress`)
    await test.info().attach('real-retraining-comparison',{body:JSON.stringify(progress),contentType:'application/json'})
    expect(progress.status).toBe('completed')
    expect(progress.attempts).toBe(1)
    expect(progress.comparable,JSON.stringify(progress.comparison_reasons)).toBe(true)
    expect(progress.dimensions[0].delta).toEqual(expect.any(Number))
    expect((await actors.admin.get(`/api/remediations/${plan.id}/next`)).status()).toBe(403)
    const confirmed=await call('admin','POST',`/cases/${example.id}/confirm`,{version:example.version})
    const generated=await call('admin','POST','/scenarios/generate',{product:'合成教学主题',disease:'软件测试',objective:'用已确认的合成案例练习需求确认，不编造医学结论。',doctor_id:doctor.id,rubric_id:rubric.id,content_ids:[content.id],case_id:confirmed.id})
    expect(generated.generation.case.id).toBe(confirmed.id)
    expect(generated.generation.case.version).toBe(confirmed.version)
    expect(generated.generation.usage.total_tokens).toBeGreaterThan(0)
  }
})

test('real providers: public doctor research, archived evidence, draft confirmation and paused watch', async () => {
  test.skip(process.env.E2E_LIVE!=='1','Opt in with E2E_LIVE=1; real search usage')
  test.setTimeout(360_000)
  const job=await call('admin','POST','/research/doctor-jobs',{name:'李小英',hospital:'复旦大学附属中山医院',department:'内分泌科'})
  await expect.poll(async()=> (await call('admin','GET',`/research/jobs/${job.id}`)).status,{timeout:300_000,intervals:[2000,5000]}).not.toMatch(/^(queued|running)$/)
  const result=await call('admin','GET',`/research/jobs/${job.id}`)
  await test.info().attach('real-doctor-research',{body:JSON.stringify(result),contentType:'application/json'})
  expect(['completed','partial']).toContain(result.status)
  expect(result.source_ids.length).toBeGreaterThan(0)
  expect(result.result.findings.length).toBeGreaterThan(0)
  // The confirmation below simulates a user action in a disposable database; it is not human identity review.
  expect((await actors.admin.post(`/api/research/jobs/${job.id}/doctor-draft`,{data:{finding_index:0,confirmed_name:'李小英',confirmed_identity:false}})).status()).toBe(422)
  const draft=await call('admin','POST',`/research/jobs/${job.id}/doctor-draft`,{finding_index:0,confirmed_name:'李小英',confirmed_identity:true})
  expect(draft.status).toBe('draft')
  expect(draft.research_evidence.length).toBeGreaterThan(0)
  expect((await call('admin','POST',`/research/jobs/${job.id}/doctor-draft`,{finding_index:0,confirmed_name:'李小英',confirmed_identity:true})).id).toBe(draft.id)
  const watch=await call('admin','PUT',`/research/jobs/${job.id}/watch`,{enabled:false})
  expect(watch.enabled).toBe(false)
})

test('PDF extraction, original download and atomic idempotent bulk import', async () => {
  const {readFileSync}=await import('node:fs')
  const pdf=readFileSync('src/assets/library/S5LGV8EM_SMS_24mg.pdf')
  const parsedResponse=await actors.admin.post('/api/content/pdf',{data:pdf,headers:{'Content-Type':'application/pdf'}})
  expect(parsedResponse.ok(),await parsedResponse.text()).toBeTruthy()
  const parsed=await parsedResponse.json()
  expect(parsed.pages.length).toBeGreaterThan(0)
  const row=await call('admin','POST','/catalog/content',{title:'PDF来源保留测试',version_label:'e2e',scope:'仅测试解析和文件保留，不作为医学审核。',pages:parsed.pages,asset_id:parsed.asset_id})
  const downloaded=await actors.admin.get(`/api/catalog/content/${row.id}/file`)
  expect(await downloaded.body()).toEqual(pdf)
  expect((await actors.a.get(`/api/catalog/content/${row.id}/file`)).status()).toBe(404)
  const body={documents:[{title:`E2E批量导入${Date.now()}`,version_label:'v1',scope:'软件测试',pages:[{number:1,text:'合成测试正文，不作为医学证据。'}]}]}
  const receipt=await call('admin','POST','/content/import',body)
  expect((await call('admin','POST','/content/import',body)).document_ids).toEqual(receipt.document_ids)
  expect((await call('admin','GET',`/catalog/content/${receipt.document_ids[0]}`)).status).toBe('draft')
})

test('drug versions, policy source validation, published rules, lessons and taxonomy', async () => {
  const drug=await publish('drug',{name:'E2E虚构药品',ownership:'company',practice_departments:['内分泌科']})
  const revision=await call('admin','POST',`/catalog/drug/${drug.id}/revision`)
  const edit=await call('admin','PUT',`/catalog/drug/${revision.id}`,{name:'E2E虚构药品修订',ownership:'company',practice_departments:['内分泌科'],version:revision.version})
  const next=await call('admin','POST',`/catalog/drug/${revision.id}/publish`,{version:edit.version})
  expect(next.id).toBe(drug.id)
  expect((await call('admin','POST',`/catalog/drug/${drug.id}/retire`,{version:next.version})).status).toBe('retired')
  let policy=await call('admin','POST','/catalog/policy',{title:'E2E合成制度',version_label:'v1',scope:'仅软件测试',issuer:'虚构测试机构',legal_status:'effective',effective_date:'2020-01-01',pages:[{number:1,text:'合成训练规则：应核对原文、适用范围和授权边界。'}]})
  for(const action of ['submit','approve'])policy=await call('admin','POST',`/catalog/policy/${policy.id}/review`,{version:policy.version,action,reason:'核对合成文本'})
  const rule=await publish('policy_rule',{name:'E2E合成规则',policy_id:policy.id,article:'测试条款',quote:'应核对原文、适用范围和授权边界',scope:'模拟沟通',risk:'low',action:'warn'})
  expect(rule.policy_version).toBe(policy.version)
  const lesson=await publish('lesson',{title:'E2E新课程',level:'L1',summary:'软件测试课程',owner:'测试组',sections:[['测试','仅验证发布后可见。']],unverified_figures:false})
  expect((await call('a','GET','/curriculum')).levels.flatMap((l:any)=>l.lessons).some((l:any)=>l.id===lesson.id)).toBe(true)
  const taxonomy=await call('admin','GET','/catalog/taxonomy')
  const category=taxonomy.find((t:any)=>t.kind==='category')
  const term=`E2E分类${Date.now()}`
  const pending=await call('admin','PUT','/catalog/taxonomy/category',{version:category.version,terms:[...category.terms,{value:term,status:'pending'}]})
  const active=await call('admin','PUT','/catalog/taxonomy/category',{version:pending.version,terms:pending.terms.map((t:any)=>t.value===term?{...t,status:'active'}:t)})
  expect(active.terms.find((t:any)=>t.value===term).status).toBe('active')
})

test('recording upload requires consent, checks real media and stays private; missing HTTPS is explicit', async () => {
  const {execFileSync}=await import('node:child_process')
  const wav=execFileSync('uv',['run','--directory','../backend','--locked','python','-c',
    'import io,wave,sys; b=io.BytesIO(); w=wave.open(b,"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(32000)); w.close(); sys.stdout.buffer.write(b.getvalue())'])
  const row=await call('a','POST','/visits',{source:'recording',visited_at:new Date().toISOString().slice(0,10)})
  const url=`/api/visits/${row.id}/audio`
  expect((await actors.a.post(url,{data:wav,headers:{'Content-Type':'audio/wav'}})).status()).toBe(422)
  expect((await actors.a.post(url,{data:Buffer.from('not audio'),headers:{'Content-Type':'audio/wav','X-Recording-Authorized':'true'}})).status()).toBe(422)
  const uploaded=await actors.a.post(url,{data:wav,headers:{'Content-Type':'audio/wav','X-Recording-Authorized':'true'}})
  expect(uploaded.ok(),await uploaded.text()).toBe(true)
  expect((await actors.a.get(url)).ok()).toBe(true)
  expect((await actors.b.get(url)).status()).toBe(404)
  const unavailable=await actors.a.post(`/api/visits/${row.id}/transcription`)
  expect(unavailable.status()).toBe(503)
  expect((await unavailable.json()).detail).toContain('HTTPS')
})

test('real providers: drug research retains verifiable archived originals', async () => {
  test.skip(process.env.E2E_LIVE!=='1','Opt in with E2E_LIVE=1; real search usage')
  test.setTimeout(360_000)
  const job=await call('admin','POST','/research/jobs',{kind:'drug',query:'玛仕度肽 中国 成人体重管理 同类药品 获批说明书 官方原文'})
  await expect.poll(async()=>(await call('admin','GET',`/research/jobs/${job.id}`)).status,{timeout:300_000,intervals:[2000,5000]}).not.toMatch(/^(queued|running)$/)
  const result=await call('admin','GET',`/research/jobs/${job.id}`)
  await test.info().attach('real-drug-research',{body:JSON.stringify(result),contentType:'application/json'})
  expect(['completed','partial']).toContain(result.status)
  const detail=result.result.findings.flatMap((f:any)=>f.details).find((d:any)=>d.source_id&&d.source_version)
  expect(detail).toBeTruthy()
  const reader=await actors.admin.get(`/api/research/sources/${detail.source_id}/${detail.source_version}/html`)
  expect(reader.ok()).toBe(true)
  const original=await actors.admin.get(`/api/research/sources/${detail.source_id}/${detail.source_version}/original`)
  const {createHash}=await import('node:crypto')
  expect(createHash('sha256').update(await original.body()).digest('hex')).toBe(detail.source_version)
  const watch=await call('admin','PUT',`/research/jobs/${job.id}/watch`,{enabled:false})
  expect(watch.enabled).toBe(false)
})

test('Word policy import keeps the original and never inherits an effective legal status', async () => {
  const {execFileSync}=await import('node:child_process')
  const word=execFileSync('uv',['run','--directory','../backend','--locked','python','-c',
    'import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("word/document.xml",\'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic policy: verify the source and authorization.</w:t></w:r></w:p></w:body></w:document>\'); z.close(); sys.stdout.buffer.write(b.getvalue())'])
  const response=await actors.admin.post('/api/research/policy-file?title=E2E%E5%90%88%E6%88%90%E6%94%BF%E7%AD%96',{data:word,headers:{'Content-Type':'application/octet-stream'}})
  expect(response.ok(),await response.text()).toBe(true)
  const draft=await response.json()
  expect(draft.status).toBe('draft');expect(draft.legal_status).toBe('unknown')
  expect(draft.pages[0].text).toContain('Synthetic policy')
  expect(await (await actors.admin.get(`/api/research/policy-file/${draft.research_upload_id}/original`)).body()).toEqual(word)
})

test('audience editing and doctor deletion preserve bound historical configurations', async () => {
  const audience=await call('admin','POST','/catalog/audience',{name:'E2E合成画像',audience_type:'representative',task:'软件测试',needs:['核对来源'],metrics:['完成次数']})
  const edited=await call('admin','PUT',`/catalog/audience/${audience.id}`,{version:audience.version,name:'E2E合成画像修订',audience_type:'representative',task:'软件流程测试',needs:['核对来源'],metrics:['完成次数']})
  expect((await call('admin','GET',`/catalog/audience/${audience.id}`)).name).toBe(edited.name)
  expect((await actors.admin.delete(`/api/catalog/doctor/${doctor.id}?version=${doctor.version}`)).status()).toBe(409)
  const unbound=await publish('doctor',{name:'E2E待删除虚构医生',specialty:'内分泌科',background_type:'fictional',population:'合成测试',focus:'来源边界',training_style:'每轮一个问题',mood:'neutral',opening:'你好'})
  expect((await actors.admin.delete(`/api/catalog/doctor/${unbound.id}?version=${unbound.version}`)).ok()).toBe(true)
  expect((await call('admin','GET','/catalog/doctor')).some((d:any)=>d.id===unbound.id)).toBe(false)
})
