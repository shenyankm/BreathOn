import { test,expect,type BrowserContext } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { fixture,coach } from '../../backend/tests-ts/helpers'
import { canonical,sha,type Doc,type User } from '../../backend/src/core'
import { hashPassword } from '../../backend/src/password'
import { newRecord } from '../../backend/src/store'
import { prepareTraining,snapshot } from '../../backend/src/training'
import { parse } from '../../backend/src/validation'

let studentStorage:Awaited<ReturnType<BrowserContext['storageState']>>|undefined
let runtime:Awaited<ReturnType<typeof fixture>>,baseline:Doc,child:Doc,scene:Doc
const origin='http://127.0.0.1:5197'
const trainerAccount='training-loop-trainer'
const account='training-loop-rep',password='isolated-training-loop-password'

test.beforeAll(async()=>{
  runtime=await fixture({auth:true,users:{[account]:await hashPassword(password),[trainerAccount]:await hashPassword(password)},admins:[trainerAccount],origins:[origin,'http://127.0.0.1:5198']})
  const user:User={id:account,workspace:'local',team:'',role:'representative',authenticated:true}
  // Synthetic records exist only in this fixture's disposable directory; no provider is configured.
  const {doctor,rubric}=await runtime.store.transaction('local',async tx=>{
    const doctor=await tx.create('local','doctor',{...parse('platform.models.Doctor',{name:'隔离验收模拟医生',specialty:'内分泌科',population:'教学',focus:'需求确认',training_style:'克制',opening:'请先确认交流需求。'}),display_name:'隔离验收模拟医生',status:'published'})
    const rubric=await tx.create('local','rubric',{...parse('platform.models.Rubric',{name:'隔离验收沟通量表',dimensions:[{key:'communication',label:'需求确认',weight:100,anchors:['未观察','待改进','基本完成','充分完成','清晰完整'],requires_content:false}]}),status:'published',calibration_status:'uncalibrated'})
    const drug=await tx.create('local','drug',{name:'玛仕度肽注射液',brand:'隔离验收',practice_departments:['内分泌科'],ownership:'company',status:'published'})
    scene=await tx.create('local','scenario',{title:'隔离验收 · 首次拜访',doctor_id:doctor.id,rubric_id:rubric.id,drug_id:drug.id,content_ids:[],policy_ids:[],stages:['opening','evidence'],status:'published',objective:'先确认医生当前的交流需求，再约定下一步。',product:'隔离验收内容',disease:'仅测试沟通流程',situation:'first_visit',background:'软件验收场景，不含医学结论。',opening:'请先确认交流需求。',objections:[],success_criteria:['复述医生的关注点','确认下一步交流安排'],duration_seconds:180,difficulty:'basic'})
    await tx.create('local','scenario',{...scene,id:undefined,title:'不应出现的草稿场景',status:'draft'})
    return {doctor,rubric}
  })
  const training=snapshot(await prepareTraining(runtime.store,user,scene.id))
  const record=(score:number,text:string)=>({...newRecord(user,'practice','assisted'),training,doctor,status:'completed',capture_status:'completed',analysis_status:'completed',ended_at:new Date().toISOString(),
    messages:[{id:'u',role:'trainee',text,final:true}],coaching:[{...coach,based_on:'u',final_report:true,assessment:{status:'complete',total:score*25,observed_weight:100,validation_errors:[],model:'isolated-fixture',evaluator_version:'isolated-fixture',rubric_id:rubric.id,rubric_name:rubric.name,rubric_fingerprint:sha(canonical(rubric.dimensions)),calibration_status:'uncalibrated',dimensions:[{key:'communication',label:'需求确认',weight:100,score,reason:'合成验收结果',utterances:[],citations:[]}]}}]})
  baseline=record(2,'您好，我先确认您的需求，再安排后续交流。')
  baseline.started_at=new Date(Date.now()-120_000).toISOString()
  await runtime.store.saveRecord(baseline,'completed')
  const plan=await runtime.store.transaction('local',tx=>tx.create('local','remediation',{owner_id:account,parent_record_id:baseline.id,scenario_id:scene.id,stage:'full',rubric_id:rubric.id,focus_key:'communication',focus_label:'需求确认',note:'隔离验收：先复述关注点，再确认下一步。',status:'assigned'}))
  child={...record(3,'我理解您的关注点是交流安排，接下来我们先确认希望讨论的问题。'),remediation_id:plan.id}
  await runtime.store.saveRecord(child,'completed')
  await runtime.sessions.finishRemediation(user,child)
  await runtime.store.transaction('local',tx=>tx.create('local','remediation',{...plan,id:undefined,status:'assigned',parent_record_id:child.id}))
  await runtime.app.listen({host:'127.0.0.1',port:8197})
})
test.afterAll(async()=>{await runtime?.close()})
test.beforeEach(async({page})=>{
  // Model the existing native preference bridge, without changing application code for browser QA.
  await page.addInitScript(()=>{(window as any).__TAURI_INTERNALS__={invoke:async(command:string)=>command==='load_training_preference'?'practice':undefined}})
  if(studentStorage)await page.context().addCookies(studentStorage.cookies)
  await page.goto('./')
  if(!studentStorage){
    await page.locator('input[name="username"]').fill(account)
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button',{name:'登录',exact:true}).click()
  }
  await expect(page.getByRole('heading',{name:'练习',exact:true})).toBeVisible()
  studentStorage=await page.context().storageState()
})

test('published scenario, free practice, focused retraining and child comparison stay connected',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await expect(page.getByText(scene.objective,{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeEnabled()
  await page.getByRole('combobox',{name:'训练场景',exact:true}).click()
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.getByRole('tab',{name:'自由练习',exact:true}).click()
  await page.getByRole('combobox',{name:'模拟医生',exact:true}).click()
  await page.getByRole('option').first().click()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeEnabled()
  await expect(page.getByText('自由练习可获得沟通复盘，不生成场景量表评分。')).toBeVisible()
  await page.getByRole('radio',{name:'实战练习',exact:true}).click()
  await page.getByRole('button',{name:'开始重练',exact:true}).click()
  const setup=page.getByRole('dialog')
  await expect(setup.getByText(/本次重练重点：需求确认/)).toBeVisible()
  await expect(setup.getByText('本次方式：辅助练习',{exact:true})).toBeVisible()
  await expect(setup.getByRole('combobox',{name:'训练场景',exact:true})).toBeDisabled()
  await expect(setup.getByRole('combobox',{name:'训练环节',exact:true})).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByRole('link',{name:'练习',exact:true}).click()
  await expect(page.getByText('沿用原演练方式：辅助练习',{exact:true})).toBeVisible()
  await expect(page.getByRole('radio',{name:'实战练习',exact:true})).toHaveCount(0)
  await page.goto(`./#records?session=${child.id}`)
  const review=page.getByRole('dialog')
  await expect(review.getByText(/原记录与最新重练的 AI 评分对比/)).toBeVisible()
  await expect(review.getByText('需求确认：2 → 3（+1）',{exact:true})).toBeVisible()
  await expect(review.getByRole('link',{name:'查看原训练记录'})).toHaveAttribute('href',`#records?session=${baseline.id}`)
  await review.getByRole('button',{name:'建立同版本补练',exact:true}).click()
  await review.getByRole('button',{name:'生成补练任务',exact:true}).click()
  await review.getByRole('button',{name:'开始针对性重练',exact:true}).last().click()
  await expect(page.getByRole('dialog',{name:'开始新的演练'})).toBeVisible()
  expect(errors).toEqual([])
})

test('scene failures and empty catalogues recover without blocking free practice',async({page})=>{
  await page.route('**/api/catalog/scenario',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'隔离验收：场景读取失败'})}))
  await page.reload()
  await expect(page.getByText('隔离验收：场景读取失败',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeDisabled()
  await page.getByRole('tab',{name:'自由练习',exact:true}).click()
  await page.getByRole('combobox',{name:'模拟医生',exact:true}).click()
  await page.getByRole('option').first().click()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeEnabled()
  await page.unroute('**/api/catalog/scenario')
  await page.getByRole('tab',{name:'场景训练',exact:true}).click()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeEnabled()
  await page.route('**/api/catalog/scenario',route=>route.fulfill({json:[]}))
  await page.reload()
  await expect(page.getByText(/暂无已发布训练场景/)).toBeVisible()
  await expect(page.getByRole('button',{name:'开始练习',exact:true})).toBeDisabled()
})

for(const width of [390,768,1440])test(`training home and expanded feedback fit ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:900})
  await expect(page.getByText(scene.objective,{exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath(`training-home-top-${width}.png`),animations:'disabled'})
  const rendered=testInfo.outputPath('rendered-home.html')
  await writeFile(rendered,await page.content())
  await testInfo.attach('rendered-home',{path:rendered,contentType:'text/html'})
  await page.getByRole('button',{name:/场景详情与评分依据/}).click()
  await page.getByRole('button',{name:/同条件反馈对比/}).click()
  await expect(page.getByText('需求确认：2 → 3（+1）',{exact:true})).toBeVisible()
  await expect(page.getByText(/计价明细|输入 token|已记录演练用量估算/)).toHaveCount(0)
  const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().right>innerWidth+1).map(el=>el.tagName))
  expect(overflow).toEqual([])
  await page.getByText('需求确认：2 → 3（+1）',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:testInfo.outputPath(`training-progress-${width}.png`),animations:'disabled'})
})

async function trainerCall(method: 'POST'|'GET', url: string, payload?: object) {
  const login = await runtime.app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:trainerAccount,password}})
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  return runtime.app.inject({method,url,headers:{origin,cookie},...(payload?{payload}:{})})
}

test('review leads with one concrete action and prepares a grounded practice task', async ({page},testInfo) => {
  await page.setViewportSize({width:390,height:900})
  await page.goto(`./#records?session=${baseline.id}`)
  const review = page.getByRole('dialog',{name:'演练复盘'})
  await expect(review.getByRole('region',{name:'下一次改什么'})).toBeVisible()
  await expect(review.getByRole('button',{name:'生成补练任务',exact:true})).toBeHidden()
  await expect(review.getByRole('heading',{name:'下一次只练：需求确认'})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('review-next-action-390.png')})
  await review.getByRole('button',{name:'直接练这个动作',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'开始新的演练'})).toBeVisible()
  await expect(page.getByText(/本次重练重点：需求确认/)).toBeVisible()
})

test('a stale pending task can restart against current content without mixing old scores', async ({page}) => {
  const copied = await runtime.store.transaction('local',tx=>tx.create('local','scenario',{...scene,id:undefined,title:'隔离版本恢复场景'}))
  const training = snapshot(await prepareTraining(runtime.store,{id:account,workspace:'local',team:'',role:'representative',authenticated:true},copied.id))
  const saved = {...baseline,id:newRecord({id:account,workspace:'local',team:'',role:'representative',authenticated:true},'practice','assisted').id,training}
  await runtime.store.saveRecord(saved,'completed')
  const created = await page.request.post(`/api/sessions/${saved.id}/retrain`,{data:{},headers:{Origin:origin}})
  expect(created.ok(),await created.text()).toBe(true)
  const plan = await created.json()
  await runtime.store.transaction('local',tx=>tx.update('local','scenario',copied.id,{...copied,objective:'使用当前版本重新确认交流需求。'},copied.version))
  await page.reload()
  await page.getByRole('button',{name:'开始重练',exact:true}).click()
  await expect(page.getByText(/医生、场景或资料版本已变化，请归档旧任务/)).toBeVisible()
  await page.getByRole('button',{name:'按当前版本重新练习',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'开始新的演练'})).toBeVisible()
  expect((await runtime.store.transaction('local',tx=>tx.require('local','remediation',plan.id),false)).status).toBe('archived')
  await expect(page.getByRole('dialog').getByText('使用当前版本重新确认交流需求。',{exact:true})).toBeVisible()
})

test('a field difficulty is submitted, reviewed and returned as a published practice entry', async ({page},testInfo) => {
  await page.setViewportSize({width:390,height:900})
  await page.getByRole('button',{name:'记录一个拜访难题',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'把拜访难题变成练习'})
  const text='隔离核查：医生时间紧张，我没有先确认交流目标。'
  await dialog.getByRole('textbox',{name:'拜访沟通难题',exact:true}).fill(text)
  await expect(dialog.getByRole('button',{name:'提交脱敏难题',exact:true})).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await expect(dialog.getByRole('button',{name:'提交脱敏难题',exact:true})).toBeEnabled()
  await page.screenshot({path:testInfo.outputPath('field-challenge-390.png')})
  await dialog.getByRole('button',{name:'提交脱敏难题',exact:true}).click()
  await expect(dialog.getByText(/难题已提交/)).toBeVisible()
  const submitted=(await (await page.request.get('/api/training/challenges')).json()).find((row:Doc)=>row.text===text)
  const reviewed=await trainerCall('POST',`/api/visits/${submitted.id}/review`,{version:submitted.version,decision:'scenario',reason:'已核对脱敏内容，适合用于时间紧张的需求确认模拟。'})
  expect(reviewed.statusCode,reviewed.body).toBe(200)
  const generated=await runtime.store.transaction('local',tx=>tx.create('local','scenario',{...scene,id:undefined,status:'published',title:'从拜访难题回流的练习',situation:'time_pressure',background:'医生希望先快速确认本次交流目标。',generation:{case:{id:reviewed.json().review.case_id}}}))
  await dialog.getByRole('button',{name:'刷新进展',exact:true}).click()
  await dialog.getByRole('button',{name:'练习这个难题：从拜访难题回流的练习',exact:true}).click()
  const setup=page.getByRole('dialog',{name:'开始新的演练'})
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('combobox',{name:'训练场景',exact:true})).toContainText(generated.title)
})

test('another scenario verification is prepared without live hints and with separate comparison semantics', async ({page}) => {
  const record={...baseline,id:newRecord({id:account,workspace:'local',team:'',role:'representative',authenticated:true},'practice','assisted').id,coaching:structuredClone(child.coaching)}
  record.coaching[0].assessment.dimensions[0].utterances=[{message_id:'u',quote:record.messages[0].text}]
  await runtime.store.saveRecord(record,'completed')
  const response=await page.request.post(`/api/sessions/${record.id}/retrain`,{data:{},headers:{Origin:origin}})
  expect(response.ok(),await response.text()).toBe(true)
  expect((await response.json()).status).toBe('awaiting_verification')
  await page.reload()
  await page.getByRole('button',{name:'开始新情境验证',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'开始新的演练'})
  await expect(dialog.getByText('本次方式：实战练习',{exact:true})).toBeVisible()
  await expect(dialog.getByText(/这是另一情境的无提示验证/)).toBeVisible()
  await expect(dialog.getByRole('combobox',{name:'训练场景',exact:true})).toBeDisabled()
  await expect(dialog.getByRole('combobox',{name:'训练场景',exact:true})).not.toContainText('隔离验收 · 首次拜访')
})

test('trainer reviews an actual independent verification through the admin UI', async ({page,browser},testInfo) => {
  const user:User={id:account,workspace:'local',team:'',role:'representative',authenticated:true}
  const parent={...baseline,id:newRecord(user,'practice','assisted').id,coaching:structuredClone(child.coaching)}
  parent.coaching[0].assessment.dimensions[0].utterances=[{message_id:'u',quote:parent.messages[0].text}]
  await runtime.store.saveRecord(parent,'completed')
  const created=await page.request.post(`/api/sessions/${parent.id}/retrain`,{data:{},headers:{Origin:origin}})
  expect(created.ok(),await created.text()).toBe(true)
  const plan=await created.json()
  const next=await (await page.request.get(`/api/remediations/${plan.id}/next`)).json()
  const text='我理解您时间有限，先确认您今天最希望解决的问题，再约定下一步。'
  const verification={...newRecord(user,'combat','independent'),training:snapshot(await prepareTraining(runtime.store,user,next.scenario_id)),
    remediation_id:plan.id,remediation_phase:'verification',capture_status:'completed',analysis_status:'completed',messages:[{id:'u',role:'trainee',text,final:true}],coaching:structuredClone(child.coaching)}
  verification.coaching[0].assessment.dimensions[0].utterances=[{message_id:'u',quote:text}]
  await runtime.store.saveRecord(verification,'completed')
  await runtime.sessions.finishRemediation(user,verification)
  const context=await browser.newContext({viewport:{width:1440,height:1000}})
  try {
    const admin=await context.newPage()
    await admin.goto('http://127.0.0.1:5198/admin/#admin?section=records')
    await admin.locator('input[name="username"]').fill(trainerAccount)
    await admin.locator('input[name="password"]').fill(password)
    await admin.getByRole('button',{name:'登录',exact:true}).click()
    await expect(admin.getByRole('heading',{name:'代表演练记录',exact:true})).toBeVisible()
    await admin.getByRole('button',{name:'查看详情',exact:true}).first().click()
    const review=admin.getByRole('region',{name:'学习表现复核'})
    await expect(review).toBeVisible()
    await review.getByRole('combobox',{name:'验证学员发言',exact:true}).click()
    await admin.getByRole('option',{name:text,exact:true}).click()
    await review.getByRole('textbox',{name:'验证原话引用',exact:true}).fill(text)
    await review.getByRole('textbox',{name:'学习表现复核理由',exact:true}).fill('原话在时间紧张情境中先确认了交流目标，并约定下一步，体现本次目标行为。')
    await review.getByRole('button',{name:'确认本次迁移表现',exact:true}).click()
    await expect(review.getByText(/本次迁移表现已复核/)).toBeVisible()
    expect((await (await page.request.get(`/api/remediations/${plan.id}/progress`)).json()).learning_status).toBe('verified')
    await review.scrollIntoViewIfNeeded()
    await admin.screenshot({path:testInfo.outputPath('trainer-learning-review-1440.png')})
  } finally {await context.close()}
})
