import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers.ts'
import { type Doc, uuid } from '../src/core.ts'
import { htmlText, normalizedText } from '../src/archive.ts'
import { estimateCost } from '../src/platform.ts'
import { Medical } from '../src/medical.ts'
import { assessPolicy } from '../src/live.ts'

const user = { id:'local',workspace:'local',team:'',role:'admin' as const,authenticated:false }
for (const [label, database] of [['SQLite', undefined], ['PostgreSQL', process.env.TEST_DATABASE_URL]] as const)
  test(`${label} scoped all retains default cross-tenant reads, empty tenant and full documents`, { skip:label==='PostgreSQL' && !database }, async () => {
    const f = await fixture({ database }), id = uuid()
    try {
      await f.store.transaction('local', async tx => {
        for (const tenant of ['', 'local', 'other']) await tx.create(tenant,'remediation',{owner_id:'another',note:'完整内容',pages:[{number:1,text:'不可丢失'}]},id)
        const all = (await tx.all('remediation')).filter(row=>row.item.id===id)
        assert.equal(all.length,3)
        for (const tenant of ['', 'local', 'other']) {
          const rows=(await tx.all('remediation',tenant)).filter(row=>row.item.id===id)
          assert.deepEqual(rows,all.filter(row=>row.tenant===tenant))
          assert.equal(rows[0].item.pages[0].text,'不可丢失')
        }
      })
    } finally { await f.close() }
  })

test('archive link caching keeps first title, canonical deduplication, priority and unsafe URL rejection', () => {
  const html=Buffer.from(`<title>合成 &amp; 标题</title><script>不得收集<script>嵌套</script></script>
    <a href="/a.pdf#one">说明书首标题</a><a href="/a.pdf#two">后标题</a><a href="/a.pdf#one">再次重复</a>
    <a href="/normal">普通链接</a><a href="/attachment">附件</a><a href="https://example.invalid:81/x">无效端口</a>
    <a href="http://127.0.0.1/x">内网</a><a href="https://example.invalid/?token=secret">凭据</a>
    <a href="/start#fragment">自己</a><a href="javascript:alert(1)">脚本链接</a>`)
  const parsed=htmlText(html,'text/html','https://example.invalid/start')
  assert.equal(parsed.title,'合成 & 标题')
  assert(!parsed.text.includes('不得收集'))
  assert.deepEqual(parsed.links,[{url:'https://example.invalid/a.pdf',title:'说明书首标题'},{url:'https://example.invalid/attachment',title:'附件'},{url:'https://example.invalid/normal',title:'普通链接'}])
  assert.deepEqual(htmlText(Buffer.from('<a href="/a.pdf">新标题</a>'),'text/html','https://other.invalid/base').links,[{url:'https://other.invalid/a.pdf',title:'新标题'}])
})

test('archive whitespace normalization preserves numeric boundaries and Unicode behavior', () => {
  for (const [input, expected] of [[' 1 \n 2 ','1 2'],['１ \n ２','１２'],['a1\t2b','a1 2b'],[' 1 \t 中 \n2 ','1中2'],['0\u00a09','0 9'],['\r\n','']]) assert.equal(normalizedText(input),expected)
  const original=(s:string)=>s.replace(/\s+/gu,(match,offset)=>offset && offset+match.length<s.length && /\d/.test(s[offset-1]) && /\d/.test(s[offset+match.length]) ? ' ' : '')
  let seed=42
  for(let trial=0;trial<200;trial++) {
    const alphabet='09a中１\t\n \u00a0\u3000'
    const text=Array.from({length:120},()=>{seed=(seed*1664525+1013904223)>>>0;return alphabet[seed%alphabet.length]}).join('')
    assert.equal(normalizedText(text),original(text))
  }
})

test('pricing keeps exact totals, first duplicate rates, damaged snapshots and ordered missing reasons', () => {
  const first={provider:'deepseek',model:'m',unit:'input_tokens',amount:'0.01',per_units:1000,currency:'CNY'}
  const output={...first,unit:'output_tokens',amount:'0.03'}
  const usage={provider:'deepseek',model:'m',prompt_tokens:2500,completion_tokens:500}
  const value=estimateCost([usage],[first,{...first,amount:'99'},output])
  assert.deepEqual(value.totals,{CNY:'0.040000'})
  assert.equal(value.status,'estimated');assert.deepEqual(value.missing,[])
  assert.equal(value.lines[0].rate,first)
  assert.deepEqual(value.lines.map((row:Doc)=>row.amount),['0.025000','0.015000'])
  const broken=estimateCost([{...usage,completion_tokens:0}],[{...first,amount:'broken'},first])
  assert.equal(broken.status,'unavailable');assert.deepEqual(broken.lines,[])
  assert.deepEqual(broken.missing,['历史计价快照损坏，此项费用无法核算。'])
  const unknown=estimateCost([{provider:'unknown',incomplete:true},{provider:'unknown',incomplete:true}],[])
  assert.deepEqual(unknown.missing,['unknown部分请求未返回用量，费用尚未完整核算。','unknown未记录可计价用量。'])
  assert.deepEqual(estimateCost([],[]),{status:'unavailable',totals:{},lines:[],missing:['未记录服务用量。']})
  const negative=estimateCost([{...usage,prompt_tokens:-1,completion_tokens:NaN}],[])
  assert.equal(negative.status,'unavailable');assert.deepEqual(negative.lines,[])
})

test('oversized medical text returns current corpus version without retrieval and legal length still retrieves', async () => {
  let loads=0,reads=0,version='v1'
  const medical=new Medical({config:{records:'/tmp/unused-perf-batch4'},transaction:async()=>{throw new Error('oversized text must not read approvals')}} as any,{config:{}} as any)
  medical.load=async()=>{loads++;return {version,products:[],sources:[],compiled:{}}}
  for(const text of ['安全'.repeat(3100),'核对安全。'.repeat(25)]) {
    const result=await medical.check(user,text)
    assert.equal(result.status,'unavailable');assert.deepEqual(result.statements,[])
    assert.equal(result.corpus_version,version);assert.match(result.reason,/本段过长/)
    version='v2'
  }
  assert.equal(loads,2)
  medical.evidence=async()=>{reads++;return {data:{version},approvals:new Map(),rows:[],sources:[]}}
  const legal=await medical.check(user,'一'.repeat(6000))
  assert.equal(reads,1);assert.equal(legal.status,'insufficient');assert.equal(legal.corpus_version,'v2')
})

test('policy cache is per snapshot, checks every rule version and discards findings after revocation', async () => {
  let reads=0,modelCalls=0,revoke=false
  const policy={status:'approved',legal_status:'effective',version:1,title:'原件',source_url:'https://example.invalid/p',pages:[{text:'合成执行条款'}]}
  const rules=Array.from({length:4},(_,i)=>({id:`r${i}`,version:1,status:'published',runtime_enforced:true,policy_id:'p',policy_version:i===3 ? 99 : 1,quote:'合成执行条款',risk:'high',action:'pause',article:'第一条'}))
  const store={transaction:async(_:string,callback:any)=>callback({list:async()=>rules,get:async()=>{reads++;return structuredClone(policy)}})}
  const models={config:{key:'synthetic'},json:async(_:unknown,input:Doc)=>{modelCalls++;assert.equal(input.rules.length,3);if(revoke)policy.status='retired';return {data:{findings:[{rule_id:'r0',status:'risk',quote:'合成执行条款',reason:'核对规则'}]},usage:{total_tokens:12}}}}
  const first=await assessPolicy(models as any,store as any,user,'合成执行条款',['p'])
  assert.equal(first.status,'complete');assert.equal(first.findings.length,1);assert.equal(reads,2)
  revoke=true
  const changed=await assessPolicy(models as any,store as any,user,'合成执行条款',['p'])
  assert.equal(changed.status,'unavailable');assert.deepEqual(changed.findings,[]);assert.equal(reads,4)
  const empty=await assessPolicy(models as any,store as any,user,'合成执行条款',[])
  assert.deepEqual(empty,{status:'skipped',findings:[]});assert.equal(reads,4);assert.equal(modelCalls,2)
})
