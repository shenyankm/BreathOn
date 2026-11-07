import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'

// Synthetic local workloads only. --root selects an immutable backend source snapshot.
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]
const root = process.argv.includes('--root') ? resolve(arg('--root')) : resolve(import.meta.dirname, '..')
const name = arg('--case'), small = process.argv.includes('--small')
const samples = process.argv.includes('--samples') ? Number(arg('--samples')) : 9
const load = (file: string) => import(pathToFileURL(join(root, 'src', file + '.ts')).href)
const core = await load('core'), storage = await load('store'), training = await load('training')
const medicalModule = await load('medical'), voice = await load('voice-protocol')
const user = { id: 'local', workspace: 'local', team: '', role: 'admin', authenticated: false }
const folder = await mkdtemp(join(tmpdir(), 'evispeak-perf-'))
const cleanup: (() => Promise<unknown>)[] = []
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
let work: () => unknown | Promise<unknown>, validation: () => unknown | Promise<unknown> = () => true
const pages = (count: number, length: number) => Array.from({ length: count }, (_, i) => ({ number: i + 1, text: ('合成原文依据，人群和安全边界需要核实。研究 2026 evidence study. ').repeat(Math.ceil(length / 44)).slice(0, length) }))
async function storeFixture() {
  const store = new storage.Store({ ...core.settings({}), records: join(folder, 'sessions') })
  await store.open(); cleanup.push(() => store.close())
  return store
}
try {
  if (name === 'scope') {
    const store = await storeFixture()
    await store.transaction('local', async (tx: any) => {
      for (let t = 0; t < (small ? 1 : 20); t++) for (let i = 0; i < (small ? 3 : 30); i++)
        await tx.create(t ? `tenant${t}` : 'local', 'remediation', { note: '合成记录'.repeat(small ? 1 : 500) }, `r${String(i).padStart(3,'0')}`)
    })
    work = () => store.transaction('local', async (tx: any) => (await tx.all('remediation', 'local')).filter((r: any) => r.tenant === 'local').map((r: any) => ({ tenant: r.tenant, id: r.item.id, note: r.item.note })), false)
  } else if (name === 'record_batch' || name === 'record_pattern') {
    const store = await storeFixture()
    for (let i = 0; i < (small ? 3 : 240); i++) await store.saveRecord({ id: `${String(i).padStart(8,'0')}-0000-4000-8000-000000000001`, workspace: 'local', owner_id: 'local', started_at: `2020-01-${String(i % 28 + 1).padStart(2,'0')}T00:00:00Z`, ended_at: '2020-02-01T00:00:00Z', messages: [{ text: '合成记录'.repeat(small ? 1 : 200), final: true }] }, 'completed')
    work = async () => (await store.records(user, 50)).map((r: any) => r.id)
  } else if (name.startsWith('html_') || name === 'escape' || name === 'normalized_text' || name === 'blocks') {
    const archive = await load('archive')
    const html = Buffer.from('<html><title>合成 &amp; 标题</title><script>不得出现的脚本</script>' + Array.from({ length: small ? 4 : 1200 }, (_, i) => `<p>原文 &amp; 资料 <a href="/source-${i % (small ? 3 : 400)}${i % 3 ? '.html' : '.pdf'}">${i % 4 ? '更多' : '附件下载'}${i % 400}</a></p>`).join('') + '</html>')
    const value = '合成<&>"\' 资料'.repeat(small ? 2 : 1500)
    const spaced = ' 12 \n 34 原文 \u3000 56\t78 安全\n '.repeat(small ? 2 : 1600)
    const blockText = ('短行资料\n' + '合成原文'.repeat(300) + '\r\n').repeat(small ? 1 : 350)
    work = () => name === 'escape' ? archive.escapeHTML(value) : name === 'normalized_text' ? archive.normalizedText(spaced) : name === 'blocks' ? archive.evidenceBlocks(blockText, 'a'.repeat(64)) : archive.htmlText(html, 'text/html; charset=utf-8', 'https://example.invalid/start')
    validation = () => { if (name.startsWith('html_')) { const result = archive.htmlText(html, 'text/html', 'https://example.invalid/start'); assert(!result.text.includes('不得出现的脚本')); assert(result.links.length <= 30) }; return true }
  } else if (name === 'medical_oversize4' || name === 'medical_parts4') {
    const data = { version: 'v', products: [], sources: [], compiled: {} }
    const documents = Array.from({ length: small ? 1 : 10 }, (_, i) => ({ id: `d${i}`, version: 1, version_label: 'v1', status: 'approved', title: '合成资料', pages: pages(small ? 1 : 8, small ? 200 : 6000) }))
    const models = { config: { key: 'synthetic' }, json: async (_: any, input: any) => ({ data: { statements: input.statements.map((s: any) => ({ id: s.id, status: 'not_medical', reason: '合成观察', correction: '', citations: [] })) }, usage: { total_tokens: 12 } }) }
    const medical = new medicalModule.Medical({ config: { records: folder }, transaction: async (_: any, cb: any) => cb({ list: async () => documents }) }, models)
    medical.load = async () => data
    if (name === 'medical_parts4') medical.evidence = async () => ({ data, approvals: new Map(), rows: [{ id: 'e', text: '合成依据' }], sources: [] })
    const text = name === 'medical_oversize4' ? '安全'.repeat(small ? 3100 : 8000) : '我先确认您的交流需求。'.repeat(small ? 1 : 24)
    work = async () => { const { checked_at, elapsed_seconds, ...result } = await medical.check(user, text); return result }
  } else if (name.startsWith('cost4')) {
    const { estimateCost } = await load('platform')
    const providers = ['deepseek','seedasr','doubao-tts','doubao-duplex']
    const rates = Array.from({ length: small ? 1 : 200 }, (_, i) => providers.flatMap(provider => ['input_tokens','output_tokens','audio_seconds','text_characters','search_requests','fetch_requests'].map(unit => ({ provider, model: `model${i}`, unit, amount: '0.1', per_units: 1000, currency: 'CNY' })))).flat()
    const usages = name === 'cost4_mapping' ? [{ provider: 'deepseek', model: 'model0', prompt_tokens: 0, completion_tokens: 0 }] : name === 'cost4_missing' ? Array.from({ length: small ? 1 : 1500 }, () => ({ provider: 'unknown', incomplete: true })) : Array.from({ length: small ? 1 : 80 }, (_, i) => ({ provider: providers[i % 4], model: `model${small ? 0 : (i * 37) % 200}`, prompt_tokens: 200, completion_tokens: 100, search_requests: 0, fetch_requests: 0, audio_seconds: 1.2, submitted_characters: 80, input_tokens: 200, output_tokens: 80 }))
    work = () => estimateCost(usages, rates)
    validation = () => { assert.deepEqual(estimateCost([], []), { status:'unavailable',totals:{},lines:[],missing:['未记录服务用量。'] }); return true }
  } else if (name.startsWith('policy4')) {
    const { assessPolicy } = await load('live'), store = await storeFixture()
    const count = small ? 1 : 20
    await store.transaction('local', async (tx: any) => {
      await tx.create('local','policy',{ title:'合成政策',status:'approved',legal_status:'effective',version_label:'v1',source_url:'https://example.invalid/policy',pages:[{number:1,text:'合成执行条款。'.repeat(small ? 1 : 15000)}]},'policy')
      for(let i=0;i<count;i++) await tx.create('local','policy_rule',{name:'合成规则',status:'published',runtime_enforced:true,policy_id:'policy',policy_version:1,quote:'合成执行条款',risk:'high',action:'pause',article:'第一条'},`rule-${String(i).padStart(2,'0')}`)
      await tx.execute('UPDATE platform_entities SET updated_at=?',['fixture'])
    })
    const text = '我会核对这条合成执行条款。'
    const models = { config:{key:'synthetic'},json:async()=>({data:{findings:Array.from({length:small ? 1 : 40},(_,i)=>({rule_id:`rule-${String(i % count).padStart(2,'0')}`,status:'risk',quote:'合成执行条款',reason:'需核对执行边界'}))},usage:{total_tokens:12}}) }
    work = () => assessPolicy(models,store,user,text,name === 'policy4_empty' ? [] : ['policy'])
  } else if (name === 'front_quotes4') {
    const { nextAction } = await import(pathToFileURL(join(root,'../frontend/src/lib/learning.ts')).href)
    const quote = '先核对原文与人群再确认安排'
    const record = { messages:Array.from({length:small ? 2 : 400},(_,i)=>({id:i === (small ? 1 : 399) ? 'target' : `m${i}`,role:'trainee',final:true,text:('合成原话。 '.repeat(small ? 1 : 300)+quote)})),coaching:[{final_report:true,points:['确认下一步'],assessment:{dimensions:[{key:'d',label:'沟通',score:1,utterances:Array.from({length:small ? 1 : 8},(_,i)=>({message_id:'target',quote:i===(small ? 0 : 7) ? quote : '不存在的引用原话'+i}))}]}}] }
    work=()=>nextAction(record)
  } else if (name === 'fields4') {
    const { schemaFields } = await load('validation')
    const value = {title:'合成资料',version_label:'v1',scope:'测试',pages:[{number:1,text:'原文'}],source_url:'https://example.invalid',irrelevant:true}
    work=()=>schemaFields('platform.models.Content',value)
  } else
  if (name.startsWith('learning_') || name === 'activity' || name === 'activity_messages') {
    const learning = await load('learning')
    const quote = '我先核对您的关注点，再确认下一步交流安排。'
    const dimensions = Array.from({ length: 10 }, (_, i) => ({ key: `d${i}`, label: `维度${i}`, score: 3, weight: 10,
      utterances: [{ message_id: 'u', quote }], anchors: ['0', '1', '2', '3', '4'] }))
    const training = { scenario: { id: 's', version: 1 }, doctor: { id: 'd', version: 1 }, rubric: { id: 'r', dimensions }, documents: [], stage: 'full' }
    const record = (i: number) => ({ id: `r${i}`, workspace: 'local', owner_id: `owner${i % 12}`, status: 'completed',
      started_at: `2020-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`, ended_at: '2020-02-01T00:00:00Z',
      capture_status: 'completed', analysis_status: 'completed', experience: 'practice', mode: 'assisted', training,
      remediation_id: `p${i}`, messages: [{ id: 'u', role: 'trainee', text: quote, final: true }],
      coaching: [{ final_report: true, based_on: 'u', assessment: { dimensions, validation_errors: [] } }] })
    if (name === 'activity' || name === 'activity_messages' || name === 'learning_observed') {
      const row = record(0)
      row.coaching = [...Array.from({ length: small ? 2 : name === 'activity' ? 1200 : 20 }, () => ({ final_report: false })), ...row.coaching] as any
      if (name === 'activity_messages') row.messages = Array.from({ length: small ? 2 : 240 }, (_, i) =>
        ({ id: i === (small ? 1 : 239) ? 'u' : `m${i}`, role: i % 2 ? 'trainee' : 'doctor', text: ('  ' + quote + '  ').repeat(small ? 1 : 40), final: true }))
      work = () => name === 'learning_observed' ? learning.observedTarget(row, 'd0') : storage.activity(row)
    } else if (name === 'learning_reviews') {
      const row = record(0), reviews = Array.from({ length: small ? 1 : 160 }, (_, i) =>
        ({ overrides: dimensions.map((d, j) => ({ key: d.key, score: (i + j) % 5, reason: `复核${i}` })) }))
      work = () => learning.reviewedDimensions(row, reviews)
      validation = () => ({ source_score_unchanged: row.coaching[0].assessment.dimensions[0].score === 3 })
    } else {
      const records = Array.from({ length: small ? 3 : 240 }, (_, i) => record(i))
      if (name === 'learning_http') records.forEach((row, i) => { row.id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001` })
      const plans = records.map(row => ({ id: row.remediation_id, owner_id: row.owner_id, parent_record_id: row.id,
        focus_key: 'd0', status: 'assigned', created_at: '2020-02-01T00:00:00Z' }))
      const reviews = records.flatMap(row => Array.from({ length: small ? 1 : 8 }, (_, i) => ({ record_id: row.id,
        overrides: [{ key: `d${i % 10}`, score: i % 5, reason: '合成复核' }] })))
      const scenes = Array.from({ length: small ? 3 : 1200 }, (_, i) => ({ id: `s${i}`, title: `场景${i}`, status: 'published', generation: { case: { id: `case${i % 120}` } } }))
      const visits = Array.from({ length: small ? 2 : 360 }, (_, i) => ({ id: `v${i}`, version: 1, owner_id: 'local', training_challenge: true,
        status: 'confirmed', redacted_text: '合成脱敏难题', review: { case_id: `case${i % 120}`, decision: 'confirm', reason: '合成复核' } }))
      const events = records.map(row => ({ record_id: row.id, owner_id: row.owner_id, created_at: '2020-01-01T00:00:00Z' }))
      const rows: Record<string, any[]> = { remediation: plans, review: reviews, learning_event: events, scenario: scenes, visit: visits }
      if (name === 'learning_http') {
        const { createApp } = await load('app')
        const runtime = await createApp({ ...core.settings({}), records: join(folder, 'sessions') }, async () => { throw new Error('Unexpected provider call') })
        cleanup.push(() => runtime.app.close())
        await runtime.app.ready()
        for (const row of records) await runtime.store.saveRecord(row, 'completed')
        await runtime.store.transaction('local', async (tx: any) => {
          for (const kind of ['remediation', 'review', 'learning_event'])
            for (let i = 0; i < rows[kind].length; i++) await tx.create('local', kind, rows[kind][i], `fixture-${kind}-${String(i).padStart(5, '0')}`)
        })
        work = async () => {
          const response = await runtime.app.inject({ method: 'GET', url: '/api/training/outcomes' })
          assert.equal(response.statusCode, 200)
          return response.json()
        }
        validation = async () => { assert.equal((await work() as any).saved_attempts, records.length); return true }
      } else {
        const handlers = new Map<string, any>()
        const store = { records: async () => records, transaction: async (_: string, callback: any) => callback({
          all: async (kind: string) => rows[kind].map(item => ({ tenant: 'local', item })), list: async (_: string, kind: string) => rows[kind],
        }) }
        learning.registerLearning({ route: (options: any) => handlers.set(options.url, options.handler) }, store)
        const handler = handlers.get(name === 'learning_challenges' ? '/api/training/challenges' : '/api/training/outcomes')
        work = () => handler({ user, params: {}, query: {} }, { code() {} })
      }
    }
  } else if (name === 'pick') {
    const row = Object.fromEntries(Array.from({ length: small ? 3 : 40 }, (_, i) => [`k${i}`, i % 3 ? i : null]))
    const keys = Object.keys(row)
    work = () => core.pick(row, keys)
    validation = () => { const result = core.pick(JSON.parse('{"__proto__":{"safe":true}}'), ['__proto__', 'absent']);
      assert.equal(Object.getPrototypeOf(result), Object.prototype); assert.ok(Object.hasOwn(result, '__proto__')); assert.equal(result.absent, null); return true }
  } else if (name === 'skills' || name === 'interactions') {
    const agents = await load('agents')
    const messages = Array.from({ length: small ? 3 : 1500 }, (_, i) => ({ role: i % 2 ? 'trainee' : 'doctor', text: '核对研究原文和合规边界。' }))
    const interactions = Array.from({ length: small ? 3 : 5000 }, (_, i) => ({ type: i % 3 ? 'manual_interrupt' : 'capture_end', status: i % 2 ? 'completed' : 'interrupted' }))
    work = () => name === 'skills' ? agents.skillNames(messages) : agents.interactionSummary(interactions)
  } else if (name === 'frontend_next') {
    const frontend = await import(pathToFileURL(join(root, '..', 'frontend', 'src', 'lib', 'learning.ts')).href)
    const quote = '先核对您的关注点，再确认下一步交流安排。'.repeat(small ? 1 : 25)
    const utterances = Array.from({ length: small ? 1 : 6 }, (_, i) => ({ message_id: `u${i}`, quote }))
    const record = { coaching: [{ final_report: true, assessment: { dimensions: Array.from({ length: 10 }, (_, i) =>
      ({ key: `d${i}`, label: `维度${i}`, score: i % 4, utterances })) }, points: ['先确认需求'] }],
      messages: [{ id: `u${utterances.length - 1}`, role: 'trainee', text: quote, final: true }] }
    work = () => frontend.nextAction(record)
  } else if (name === 'summary_quotes') {
    const quote = '我会先核对研究原文和适用人群。'
    const messages = [{ id: 'u', role: 'trainee', final: true, text: (quote + ' \n').repeat(small ? 1 : 600) }]
    const quotes = Array.from({ length: 4 }, () => ({ message_id: 'u', quote }))
    const raw = { dimensions: ['compliance', 'communication'].map(key => ({ key, score: 80, reason: '合成观察', quotes })), edits: [] }
    work = () => { const { created_at, ...result } = medicalModule.validateSummary(raw, { messages, capture_status: 'completed' }, 'synthetic', []); return result }
  } else if (name.startsWith('retrieve')) {
    const documents = Array.from({ length: small ? 2 : 24 }, (_, i) => ({ id: `doc-${String(i).padStart(3, '0')}`, version: 2, title: '合成资料', pages: pages(small ? 2 : 24, small ? 180 : 8000) }))
    const query = name === 'retrieve_blank' ? '' : name === 'retrieve_terms' ? '研究适用人群需要核对安全边界'.repeat(small ? 1 : 250) : '原文依据 人群 安全 evidence study 2026'
    work = () => training.retrieve(documents, query, name === 'retrieve_zero' ? 0 : 10)
  } else if (name === 'assessment') {
    const quote = '请先核对研究原文与适用人群，再讨论后续安排。'
    const history = [{ id: 'u', speaker: 'trainee', final: true, text: (quote + ' \n').repeat(small ? 2 : 160) }]
    const evidence = [{ id: 'D1', text: history[0].text, title: '合成依据' }]
    const dimensions = Array.from({ length: small ? 1 : 6 }, (_, i) => ({ key: `d${i}`, weight: i === 5 ? 20 : 16, requires_content: true, anchors: ['0', '1', '2', '3', '4'] }))
    const captured = { rubric: { id: 'r', name: '合成量表', dimensions }, evidence }
    const raw = { dimensions: dimensions.map(d => ({ key: d.key, score: 3, reason: '合成评价', utterances: Array.from({ length: 4 }, () => ({ message_id: 'u', quote })), citations: Array.from({ length: 3 }, () => ({ source_id: 'D1', quote })) })) }
    work = () => training.validateAssessment(raw, captured, history, 'synthetic')
  } else if (name === 'normalize') {
    const value = ('原文 \t\n\r  依据\u00a0\u3000 人群 安全。').repeat(small ? 2 : 1000)
    work = () => core.normalize(value)
    assert.equal(work(), value.split(/\s/u).join(''))
  } else if (name === 'unique') {
    const values = Array.from({ length: small ? 1 : 1000 }, (_, i) => i % 100)
    work = () => core.unique(values)
    assert.notEqual(work(), values)
  } else if (name === 'speech_observe') {
    const speech = new voice.SpeechEvidence(), pcm = Buffer.alloc(641)
    for (let i = 0; i < 320; i++) pcm.writeInt16LE((i * 173) % 65536 - 32768, 1 + i * 2)
    work = () => {
      speech.frames = []
      for (let i = 0; i < (small ? 1 : 100); i++) speech.observe(pcm.subarray(1), i % 2 === 0, i % 7 === 0)
      return speech.frames
    }
  } else if (name === 'asr_packet') {
    const pcm = Buffer.alloc(small ? 640 : 6400)
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * 5000), i * 2)
    work = () => {
      const packet = voice.asrPacket(pcm, true, true)
      assert.equal(packet.readUInt32BE(4), packet.length - 8)
      return [packet.subarray(0, 4).toString('hex'), gunzipSync(packet.subarray(8)).toString('base64')]
    }
  } else if (name === 'frontend_update' || name === 'frontend_sources') {
    const frontend = await import(pathToFileURL(join(root, '..', 'frontend', 'src', 'lib', 'medical.ts')).href)
    if (name === 'frontend_update') {
      const rows = Array.from({ length: small ? 3 : 1500 }, (_, i) => ({ message_id: `u${i}`, text: '合成原话', status: 'checking', statements: [] }))
      const updated = { ...rows[0], status: 'supported' }
      work = () => frontend.updateMedicalChecks(rows, updated)
      assert.equal((work() as any[])[0], updated)
      assert.equal(rows[0].status, 'checking')
    } else {
      const sources = Array.from({ length: small ? 5 : 1200 }, (_, i) => ({ id: `s${i}` }))
      const products = Array.from({ length: small ? 2 : 60 }, (_, i) => ({ id: `p${i}`, sources: sources.filter((_, j) => j % 4 === i % 4).map(s => s.id).reverse() }))
      work = () => [...frontend.indexProductSources(products, sources)]
    }
  } else if (name === 'asr' || name === 'asr_disk') {
    const { Dialogue } = await load('live'), count = name === 'asr_disk' ? (small ? 1 : 20) : (small ? 10 : 2000)
    const initial = Array.from({ length: count }, (_, i) => ({ id: `combat-u-${i}`, role: 'trainee', text: `旧的合成原话${i}`, final: true, annotation: 'preserved' }))
    const utterances = initial.map((_, i) => ({ text: `修正后的合成原话${i}`, definite: true }))
    const store = { config: { records: join(folder, 'sessions') } }
    let durable = true, checkpointCalls = 0
    work = async () => {
      const record = { id: '00000000-0000-4000-8000-000000000001', ...user, workspace: 'local', owner_id: 'local', started_at: '2026-11-06T00:00:00Z', experience: 'combat', mode: 'assisted', messages: structuredClone(initial), usage: [] }
      const sent: any[] = [], dialogue = new Dialogue({ send: async (event: any) => {
        if (name === 'asr_disk' && event.type === 'transcript') {
          const saved = await readFile(join(store.config.records, 'checkpoints', record.id + '.json'), 'utf8').then(JSON.parse).catch(() => null)
          if (!saved?.messages.some((message: any) => message.id === event.id && message.text === event.text)) durable = false
        }
        sent.push(event)
      } }, store, {}, {}, user, record)
      dialogue.scheduleChecks = () => {}
      if (name !== 'asr_disk') dialogue.checkpoint = async () => { checkpointCalls++ }
      await dialogue.observe({ utterances }, false)
      return { messages: record.messages.map((m: any) => [m.id, m.text, m.final, m.annotation]), sent }
    }
    validation = () => ({ durable_acknowledgements: durable, checkpoint_calls: name === 'asr_disk' ? undefined : checkpointCalls > 0 })
  } else if (name.startsWith('medical_')) {
    const count = small ? 2 : name === 'medical_url' ? 200 : name === 'medical_facts' || name === 'medical_claims' ? 1 : 12
    const pageCount = small ? 2 : name === 'medical_url' || name === 'medical_facts' || name === 'medical_claims' ? 1 : 18
    const pageLength = small ? 200 : name === 'medical_url' ? 300 : name === 'medical_facts' ? 180000 : 6000
    const documents = Array.from({ length: count }, (_, i) => ({ id: `doc-${String(i).padStart(4, '0')}`, version: 2, version_label: 'v2', status: 'approved', title: '合成材料', source_url: name === 'medical_url' ? `https://example.org/${i}` : 'https://example.org/shared', pages: pages(pageCount, pageLength) }))
    const sources = Array.from({ length: small ? 2 : name === 'medical_url' ? 1500 : name === 'medical_facts' ? 1 : 18 }, (_, i) => ({ id: `source-${i}`, title: '合成原始来源', url: name === 'medical_url' ? `https://example.org/${i}` : 'https://example.org/shared', kind: 'label', product_ids: ['synthetic'], trials: ['study-2026'], published_at: '2026-01-01', pages: pages(pageCount, pageLength) }))
    if (name === 'medical_unmatched') for (const document of documents) document.source_url = 'https://unmatched.example.org/'
    if (name === 'medical_unique') {
      sources.splice(documents.length)
      documents.forEach((document, i) => {
        document.source_url = sources[i].url = `https://example.org/unique-${i}`
        document.pages.forEach(page => { page.text += ` unique-document-${i}-page-${page.number}` })
        sources[i].pages = document.pages.map(page => ({ ...page }))
      })
    }
    const data = { version: 'synthetic', products: [{ id: 'synthetic', name: '合成药品', aliases: [] }], sources,
      compiled: { synthetic: { facts: Array.from({ length: small ? 2 : name === 'medical_facts' ? 160 : name === 'medical_claims' ? 80 : 0 }, () => ({ source_id: 'source-0', page: 1, claim: '原文依据与安全人群需要核实，' + '合成文本 '.repeat(name === 'medical_claims' && !small ? 1000 : 20) })) } } }
    const store = { config: { records: folder }, transaction: async (_tenant: string, callback: any) => callback({ list: async () => documents }) }
    const medical = new medicalModule.Medical(store, { config: {} })
    medical.load = async () => data
    const query = name === 'medical_flags' ? '合成药品 2026 安全 人群 医保 '.repeat(small ? 1 : 50) : '合成药品 2026 原文依据 安全 人群 医保 evidence study'
    if (name === 'medical_empty') {
      work = async () => { const checks = [{ status: 'checking', statements: [] }, { status: 'insufficient', statements: [] }]; await medical.invalidate(user, checks); return checks }
    } else {
      work = async () => {
        const result = await medical.evidence(user, name === 'medical_blank' ? '' : query)
        return { approvals: [...result.approvals], rows: result.rows }
      }
    }
  } else if (name === 'catalog' || name === 'sqlite_queries' || name === 'records') {
    const store = await storeFixture()
    if (name === 'catalog') {
      const { Catalog } = await load('catalog'), catalog = new Catalog(store)
      await store.transaction('local', async (tx: any) => {
        for (let i = 0; i < (small ? 3 : 24); i++) await tx.create('local', 'content', { title: `资料 ${i}`, version_label: '1', status: i % 3 ? 'approved' : 'draft', scope: '合成测试', pages: pages(1, small ? 200 : 400000) }, `doc-${i}`)
      })
      work = async () => (await catalog.list(user, 'content')).map((row: any) => ({ id: row.id, title: row.title, status: row.status, usable: row.usable, pages_present: 'pages' in row }))
    } else if (name === 'sqlite_queries') {
      await store.transaction('local', async (tx: any) => { for (let i = 0; i < 100; i++) await tx.create('local', 'audience', { name: `数据 ${i}` }, `item-${i}`) })
      work = () => store.transaction('local', async (tx: any) => { const result = []; for (let i = 0; i < (small ? 1 : 150); i++) result.push((await tx.require('local', 'audience', `item-${i % 100}`)).name); return result }, false)
    } else {
      const rows = Array.from({ length: small ? 2 : 400 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`, workspace: 'local', owner_id: 'local', status: 'completed', started_at: `2026-11-06T00:${String(i % 60).padStart(2, '0')}:00Z`, ended_at: `2026-11-06T01:${String(i % 60).padStart(2, '0')}:00Z`, messages: [{ text: '合成记录 '.repeat(250), final: true }] }))
      for (let offset = 0; offset < rows.length; offset += 16)
        await Promise.all(rows.slice(offset, offset + 16).map(record => storage.privateWrite(join(store.config.records, record.id + '.json'), JSON.stringify(record))))
      work = async () => (await store.records(user, null)).map((record: any) => [record.id, record.messages.length])
    }
  } else if (name === 'visibility') {
    const rows = Array.from({ length: small ? 3 : 5000 }, (_, i) => ({ document: JSON.stringify({ id: `item-${i}`, owner_id: i % 2 ? 'local' : 'other', status: 'assigned' }) }))
    const tx = new storage.Transaction(async () => rows)
    work = () => core.identity.run({ ...user, authenticated: true }, async () => (await tx.list('local', 'remediation')).map((row: any) => row.id))
  } else if (name === 'fingerprint') {
    const captured = { scenario: { id: 's', version: 1 }, doctor: { id: 'd', version: 1 }, rubric: { id: 'r', version: 1, dimensions: Array.from({ length: small ? 2 : 12 }, (_, i) => ({ key: `d${i}`, anchors: ['未观察', '待改进', '基本完成', '充分完成', '清晰完整'], weight: i + 1 })) }, documents: [{ id: 'doc', version: 1, sha256: 'synthetic' }], drugs: [], policies: [] }
    work = () => { let last; for (let i = 0; i < (small ? 1 : 300); i++) last = storage.trainingFingerprint(captured); return last }
    validation = () => { const before = storage.trainingFingerprint(captured); captured.rubric.dimensions[0].weight++; const after = storage.trainingFingerprint(captured); return { detects_mutation: before !== after } }
  } else if (name === 'canonical') {
    const value = { z: null, a: [{ name: '引号"与中文', fields: [true, false, null, -0, 1.25] }], pages: pages(small ? 1 : 180, small ? 80 : 3000) }
    work = () => core.canonical(value)
  } else if (name === 'base64') {
    const encoded = Buffer.alloc(small ? 640 : 64000, 5).toString('base64')
    work = () => { const decoded = voice.decode64(encoded); return [decoded.length, decoded[0], decoded.at(-1)] }
    validation = () => {
      for (const value of ['A===', 'A', '====', 'AA=A', ' AAA', 'AAAA\n', 'AA==AAAA', '!!!!']) assert.throws(() => voice.decode64(value))
      for (const length of [0, 1, 2, 3, 31, 640]) assert.equal(voice.decode64(Buffer.alloc(length).toString('base64')).length, length)
      return true
    }
  } else if (name === 'speech') {
    const speech = new voice.SpeechEvidence()
    speech.frames = Array.from({ length: small ? 20 : 30000 }, (_, i) => ({ power: (i % 300) ** 2, muted: i % 9 === 0, playing: i % 3 === 0 ? true : i % 7 === 0 ? undefined : false }))
    work = () => Array.from({ length: small ? 1 : 80 }, (_, i) => speech.describe(small ? 0 : i * 200, small ? 400 : i * 200 + 24000))
  } else if (name === 'summary') {
    const messages = Array.from({ length: small ? 2 : 400 }, (_, i) => ({ id: `u${i}`, role: 'trainee', text: `我会核对原文和适用人群${i}。`, final: true }))
    const checks = messages.flatMap((message: any) => [{ message_id: message.id, text: message.text, status: 'not_medical', statements: [] }, { message_id: message.id, text: '另一版原话', status: 'unavailable', statements: [] }, { message_id: message.id, text: message.text, status: 'supported', statements: [{ status: 'supported', citations: [] }] }])
    const raw = { dimensions: ['compliance', 'communication'].map(key => ({ key, score: 80, reason: '合成观察', quotes: [{ message_id: 'u0', quote: '核对原文' }] })), edits: [] }
    work = () => { const { created_at, ...result } = medicalModule.validateSummary(raw, { messages, capture_status: 'completed' }, 'synthetic', checks); return result }
  } else if (name === 'citations') {
    const text = Array.from({ length: small ? 1 : 24 }, (_, i) => `第${i}句原始研究结论必须核对适用人群。`).join('')
    const evidence = Array.from({ length: small ? 2 : 12 }, (_, i) => ({ id: `e${i}`, text: `合成来源${i}。` + '原始研究结论必须核对适用人群。 '.repeat(60), source_id: `source${i}`, page: 1, document_id: `doc${i}`, document_version: 1, document_sha256: 'synthetic', source: { title: `合成原件标题${i}`, kind: 'label', quality: 'original' } }))
    const raw = { statements: medicalModule.sentences(text).map((_: string, i: number) => ({ id: `s${i}`, status: 'supported', reason: '可核对原文', correction: '', citations: Array.from({ length: small ? 1 : 6 }, (_, j) => ({ chunk_id: `e${(i * 4 + j) % evidence.length}`, quote: '原始研究结论必须核对适用人群。' })) })) }
    work = () => medicalModule.validateMedical(raw, text, evidence)
  } else throw new Error('Unknown workload: ' + name)

  await work!(); await work!()
  const start = performance.now(); let value = await work!(); const estimate = performance.now() - start
  const iterations = Math.max(1, Math.min(1500, Math.ceil(30 / Math.max(estimate, 0.01))))
  const elapsed: number[] = [], cpu: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    global.gc?.()
    const before = process.cpuUsage(), begin = performance.now()
    for (let i = 0; i < iterations; i++) value = await work!()
    elapsed.push((performance.now() - begin) / iterations)
    const spent = process.cpuUsage(before); cpu.push((spent.user + spent.system) / iterations)
  }
  const ordered = [...elapsed].sort((a, b) => a - b)
  console.log(JSON.stringify({ case: name, small, samples, iterations, elapsed_ms: elapsed, median_ms: ordered[Math.floor(ordered.length / 2)], p95_ms: ordered[Math.ceil(ordered.length * .95) - 1], cpu_us: cpu, output_sha256: hash(value), validation: await validation(), node: process.version, platform: process.platform, arch: process.arch }))
} finally {
  for (const close of cleanup.reverse()) await close()
  await rm(folder, { recursive: true, force: true })
}
