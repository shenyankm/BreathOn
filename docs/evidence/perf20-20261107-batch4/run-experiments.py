"""Twenty fresh general-performance candidates from b88a26e, isolated serial A/B."""
from pathlib import Path
import difflib,json,shutil,subprocess,statistics
ROOT=Path(__file__).resolve().parents[3];E=Path(__file__).resolve().parent
RUN=Path(Path('/tmp/evispeak-perf20-batch4-root').read_text().strip());BENCH=ROOT/'backend/benchmarks/performance-twenty-batch4.ts'
C=[]
def c(title,case,file,before,after):C.append(dict(title=title,case=case,changes={file:[(before,after)]}))
c('学习管理查询在数据库按租户限制 all，保留默认跨租户接口','scope','backend/src/store.ts',"""  async all(kind: string): Promise<{ tenant: string; item: Doc }[]> {
    return (
      await this.execute('SELECT tenant_id,document FROM platform_entities WHERE kind=?', [kind])
    ).map((row) => ({ tenant: row.tenant_id, item: JSON.parse(row.document) }))
  }""","""  async all(kind: string, tenant?: string): Promise<{ tenant: string; item: Doc }[]> {
    return (
      await this.execute(`SELECT tenant_id,document FROM platform_entities WHERE kind=?${tenant === undefined ? '' : ' AND tenant_id=?'}`,
        tenant === undefined ? [kind] : [kind, tenant])
    ).map((row) => ({ tenant: row.tenant_id, item: JSON.parse(row.document) }))
  }""")
C[-1]['changes']['backend/src/learning.ts']=[("tx.all('remediation')","tx.all('remediation', user.workspace)"),("tx.all('learning_event')","tx.all('learning_event', user.workspace)")]
c('本地会话文件读取批量从8调至16','record_batch','backend/src/store.ts',"offset += 8)","offset += 16)")
C[-1]['changes']['backend/src/store.ts'].append(('files.slice(offset, offset + 8)','files.slice(offset, offset + 16)'))
c('本地会话文件名筛选复用无状态正则','record_pattern','backend/src/store.ts','@record_pattern','')
c('网页归档按集合去重链接，保留首个标题与顺序','html_links4','backend/src/archive.ts',"    titles: string[] = [],\n    links: Doc[] = []","    titles: string[] = [],\n    links: Doc[] = [],\n    seenLinks = new Set<string>()")
C[-1]['changes']['backend/src/archive.ts'].append(("""            if (target !== url && !links.some((row) => row.url === target))
              links.push({ url: target, title: anchor.title.trim().slice(0, 200) })""","""            if (target !== url && !seenLinks.has(target)) {
              seenLinks.add(target)
              links.push({ url: target, title: anchor.title.trim().slice(0, 200) })
            }"""))
c('网页归档在一次页面解析中复用相同 href 的规范化结果','html_links4','backend/src/archive.ts',"  let skip = 0,","  const targets = new Map<string, string>()\n  let skip = 0,")
C[-1]['changes']['backend/src/archive.ts'].append(("            const target = canonicalURL(new URL(anchor.url, url).href)","            let target = targets.get(anchor.url)\n            if (target === undefined) {\n              target = canonicalURL(new URL(anchor.url, url).href)\n              targets.set(anchor.url, target)\n            }"))
c('网页归档链接优先级只计算一次再稳定排序','html_links4','backend/src/archive.ts','@link_rank','')
c('HTML转义复用固定实体表，避免每个字符分配对象','escape','backend/src/archive.ts',"export const escapeHTML = (value: string) =>","const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }\nexport const escapeHTML = (value: string) =>")
C[-1]['changes']['backend/src/archive.ts'].append(("(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[char]!","(char) => entities[char]!"))
c('原文数字间空白核对使用等价ASCII范围判断','normalized_text','backend/src/archive.ts',"    /\\d/.test(value[offset - 1]) &&\n    /\\d/.test(value[offset + match.length])","    value.charCodeAt(offset - 1) >= 48 && value.charCodeAt(offset - 1) <= 57 &&\n    value.charCodeAt(offset + match.length) >= 48 && value.charCodeAt(offset + match.length) <= 57")
c('原文证据块复用版本编号前缀','blocks','backend/src/archive.ts',"  return blocks.map((text, index) => ({ id: `E${index + 1}-${version.slice(0, 12)}`, text }))","  const prefix = version.slice(0, 12)\n  return blocks.map((text, index) => ({ id: `E${index + 1}-${prefix}`, text }))")
c('超长医学输入仅读语料版本，不执行注定无效的检索','medical_oversize4','backend/src/medical.ts',"""    const started = Date.now(),
      { data, approvals, rows: evidence } = await this.evidence(u, text, context),""","""    const started = Date.now(),
      oversized = text.length > 6000 || sentences(text).length > 24,
      { data, approvals, rows: evidence } = oversized
        ? { data: await this.load(), approvals: new Map<string, Doc>(), rows: [] }
        : await this.evidence(u, text, context),""")
C[-1]['changes']['backend/src/medical.ts'].append(('    if (text.length > 6000 || sentences(text).length > 24)','    if (oversized)'))
c('医学核验长度与模型输入复用分句结果','medical_parts4','backend/src/medical.ts','@parts','')
c('计费按服务建立当次价格候选组，保留首项匹配和严格比较','cost4','backend/src/platform.ts',"  for (const usage of usages) {","  const byProvider = new Map<unknown, Doc[]>()\n  for (const rate of rates) {\n    const group = byProvider.get(rate.provider)\n    if (group) group.push(rate)\n    else byProvider.set(rate.provider, [rate])\n  }\n  for (const usage of usages) {")
C[-1]['changes']['backend/src/platform.ts'].append(('const rate = rates.find(','const rate = byProvider.get(provider)?.find('))
c('计费字段映射移至模块常量','cost4_mapping','backend/src/platform.ts','@cost_fields','')
c('计费缺失依据提示按集合去重，保留首次顺序','cost4_missing','backend/src/platform.ts','@cost_missing','')
c('无关联政策时跳过必为空的规则查询','policy4_empty','backend/src/live.ts',"  const load = () =>","  if (!ids.length) return { status: 'skipped', findings: [] }\n  const load = () =>")
c('每次合规规则快照复用相同政策读取，发布后重新加载','policy4_cache','backend/src/live.ts',"        const rows: Doc[] = []","        const rows: Doc[] = [], loaded = new Map<string, Doc | null>()")
C[-1]['changes']['backend/src/live.ts'].append(("          const policy = await tx.get(u.workspace, 'policy', rule.policy_id)","          if (!loaded.has(rule.policy_id)) loaded.set(rule.policy_id, await tx.get(u.workspace, 'policy', rule.policy_id))\n          const policy = loaded.get(rule.policy_id) ?? null"))
c('合规结果匹配建立规则首项索引','policy4_cache','backend/src/live.ts',"    assert(Array.isArray(data.findings), 502, '无效合规判断。')","    assert(Array.isArray(data.findings), 502, '无效合规判断。')\n    const byId = new Map<string, Doc>()\n    for (const rule of rules) if (!byId.has(rule.id)) byId.set(rule.id, rule)")
C[-1]['changes']['backend/src/live.ts'].append(('const rule = rules.find((rule) => rule.id === row?.rule_id)','const rule = byId.get(row?.rule_id)'))
c('前端复盘按编号索引完整学员原话，保留重复编号语义','front_quotes4','frontend/src/lib/learning.ts','@front_index','')
c('前端复盘重复引文按需复用原话规范化','front_quotes4','frontend/src/lib/learning.ts',"  const quote = dimension?.utterances.find(quote => {","  const normalized = new Map<string, string>()\n  const sourceText = (text: string) => {\n    let value = normalized.get(text)\n    if (value === undefined) { value = compact(text); normalized.set(text, value) }\n    return value\n  }\n  const quote = dimension?.utterances.find(quote => {")
C[-1]['changes']['frontend/src/lib/learning.ts'].append(('compact(message.text).includes(text)','sourceText(message.text).includes(text)'))
c('场景迁移字段投影按固定schema复用字段名','fields4','backend/src/validation.ts',"export function schemaFields(name: string, value: Doc): Doc {","const fieldKeys = new Map<string, string[]>()\nexport function schemaFields(name: string, value: Doc): Doc {\n  let keys = fieldKeys.get(name)\n  if (!keys) { keys = Object.keys(schemas[name].properties); fieldKeys.set(name, keys) }")
C[-1]['changes']['backend/src/validation.ts'].append(('    Object.keys(schemas[name].properties)\n      .filter','    keys\n      .filter'))

def transform(s,b,a):
 if b=='@record_pattern':
  s=s.replace('export class Store {','const recordName = /^[0-9a-f-]{36}\\.json$/i\nexport class Store {',1)
  return s.replace('/^[0-9a-f-]{36}\\.json$/i.test(file)','recordName.test(file)',1)
 if b=='@link_rank':
  start=s.index('    links: links\n      .sort(');end=s.index('\n  }\n}',start)
  return s[:start]+'''    links: links.map(link => ({ link, priority: 2 * Number(!link.url.toLowerCase().endsWith('.pdf')) + Number(!/附件|说明书|正文|下载/.test(link.title)) }))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 30).map(row => row.link),'''+s[end:]
 if b=='@parts':
  start=s.index('  async check(u: User, text: string');end=s.index('  async invalidate(',start);block=s[start:end]
  block=block.replace('const started = Date.now(),','const started = Date.now(),\n      parts = text.length <= 6000 ? sentences(text) : [],',1).replace('sentences(text).length > 24','parts.length > 24').replace('statements: sentences(text).map','statements: parts.map')
  return s[:start]+block+s[end:]
 if b=='@cost_fields':
  start=s.index('export function estimateCost(');f=s.index('    fields: Doc = {',start);end=s.index('\n  ',s.index('\n    }',f)+1)
  block=s[f:end];assert block.endswith('    }')
  const=block.replace('    fields: Doc = {','const fields: Doc = {',1)
  s=s[:f-2]+s[end:] # remove preceding comma and newline declaration separator
  # The missing declaration now needs its own semicolon-free end.
  s=s.replace('    missing: string[] = []\n  const byProvider','    missing: string[] = []\n  const byProvider',1)
  return s[:start]+const+'\n'+s[start:]
 if b=='@cost_missing':
  start=s.index('export function estimateCost(');end=s.index('export async function curriculum(',start);block=s[start:end]
  block=block.replace('missing: string[] = []','missing = new Set<string>()').replace('missing.push(','missing.add(').replace('missing.length','missing.size')
  block=block.replace("missing: unique(missing.size ? missing : usages.length ? [] : ['未记录服务用量。']),","missing: missing.size ? [...missing] : usages.length ? [] : ['未记录服务用量。'],")
  return s[:start]+block+s[end:]
 if b=='@front_index':
  s=s.replace('  const quote = dimension?.utterances.find(quote => {',"  const eligible = new Map<string, typeof record.messages>()\n  for (const message of record.messages) {\n    if (message.role !== 'trainee' || !message.final) continue\n    const group = eligible.get(message.id)\n    if (group) group.push(message)\n    else eligible.set(message.id, [message])\n  }\n  const quote = dimension?.utterances.find(quote => {",1)
  before="""return text.length >= 6 && record.messages.some(message => message.id === quote.message_id &&
      message.role === 'trainee' && message.final && compact(message.text).includes(text))"""
  assert before in s
  return s.replace(before,"return text.length >= 6 && (eligible.get(quote.message_id)?.some(message => compact(message.text).includes(text)) ?? false)",1)
 # The two remediation callers intentionally share the same replacement.
 count=s.count(b);assert count>=1,(b,count)
 if b=="tx.all('remediation')":assert count==2;return s.replace(b,a)
 assert count==1,(b,count)
 return s.replace(b,a,1)

def snapshot(dst):
 for part in ['backend','frontend']:
  target=dst/part;target.mkdir(parents=True)
  shutil.copytree(ROOT/part/'src',target/'src',ignore=shutil.ignore_patterns('assets'))
  (target/'node_modules').symlink_to(ROOT/part/'node_modules',target_is_directory=True)
  if part=='backend':
   for name in ['resources','migrations','parsers']:(target/name).symlink_to(ROOT/part/name,target_is_directory=True)
def measure(folder,case,small=False,samples=7):
 command=['node','--experimental-transform-types','--expose-gc',str(BENCH),'--root',str(folder/'backend'),'--case',case,'--samples',str(samples)]
 if small:command.append('--small')
 result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=120)
 if result.returncode:raise RuntimeError(result.stderr)
 return json.loads(result.stdout.strip().splitlines()[-1])
def summary(rows):
 vals={v:[r['measurement']['median_ms'] for r in rows if r['version']==v] for v in 'AB'};a,b=map(statistics.median,[vals['A'],vals['B']])
 return dict(before_ms=a,after_ms=b,improvement_percent=(a-b)/a*100,paired_percent=[(a-b)/a*100 for a,b in zip(vals['A'],vals['B'])])
if __name__=='__main__':
 assert len(C)==20
 if not (RUN/'initial').exists():snapshot(RUN/'initial')
 results=json.loads((E/'results.json').read_text()) if (E/'results.json').exists() else []
 for index,item in enumerate(C,1):
  if index<=len(results):continue
  originals={f:(ROOT/f).read_text() for f in item['changes']};A=RUN/f'round-{index:02}-A';B=RUN/f'round-{index:02}-B';snapshot(A);accepted=False
  try:
   patch=''
   for f,changes in item['changes'].items():
    value=originals[f]
    for b,a in changes:value=transform(value,b,a)
    assert value!=originals[f]
    (ROOT/f).write_text(value);patch+=''.join(difflib.unified_diff(originals[f].splitlines(True),value.splitlines(True),fromfile='a/'+f,tofile='b/'+f))
   (E/f'round-{index:02}.patch').write_text(patch);snapshot(B)
   large=[dict(version=v,measurement=measure(A if v=='A' else B,item['case'])) for v in 'ABBAAB']
   small=[dict(version=v,measurement=measure(A if v=='A' else B,item['case'],True)) for v in 'ABBA']
   ls=summary(large);ss=summary(small)
   equivalent=all(len({r['measurement']['output_sha256'] for r in group})==1 for group in [large,small])
   accepted=equivalent and ls['improvement_percent']>=5 and sum(p>=5 for p in ls['paired_percent'])>=2 and (ss['improvement_percent']>=-15 or ss['after_ms']-ss['before_ms']<.05)
   row=dict(round=index,title=item['title'],case=item['case'],accepted=accepted,equivalent=equivalent,reason='retained' if accepted else 'output mismatch' if not equivalent else 'insufficient or unstable improvement or small-load regression',large=ls,small=ss,large_runs=large,small_runs=small)
   results.append(row);(E/f'round-{index:02}.json').write_text(json.dumps(row,ensure_ascii=False,indent=2)+'\n');(E/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
   print(f'{index:02} {"KEEP" if accepted else "REVERT"} {ls["before_ms"]:.5f}->{ls["after_ms"]:.5f}ms ({ls["improvement_percent"]:+.1f}%) {item["title"]}',flush=True)
  except Exception as error:
   (E/f'round-{index:02}-error.txt').write_text(str(error));raise
  finally:
   if not accepted:
    for f,s in originals.items():(ROOT/f).write_text(s)
 snapshot(RUN/'final');(E/'measurement-benchmark.ts').write_text(BENCH.read_text())
 print('Completed 20 new candidates; retained '+str(sum(r['accepted'] for r in results)),flush=True)
