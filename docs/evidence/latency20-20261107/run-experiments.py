"""Twenty fresh latency candidates; serial ABBAAB/ABBA probes, no live credentials."""
import difflib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
ROOT=Path(__file__).resolve().parents[3]
EVIDENCE=Path(__file__).resolve().parent
RUN=Path(Path('/tmp/evispeak-latency20-root').read_text().strip())
BENCH=ROOT/'backend/benchmarks/latency-twenty.ts'
CANDIDATES=[]
def candidate(title,case,changes,**extra):CANDIDATES.append(dict(title=title,case=case,changes=changes,**extra))

provider='''  private providerFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
    this.slots.run(async () => {
      const signal = init?.signal
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted()
        try {
          const response = await this.fetcher(input, init)
          if (attempt === 0 && [408, 429, 500, 502, 503, 504, 529].includes(response.status)) {
            await response.body?.cancel()
            count('retry.agent_call')
            await delay(500, undefined, { signal: signal ?? undefined })
            continue
          }
          if (!response.body) { resolve(response); return }
          const reader = response.body.getReader()
          let abort: () => void, downstream: ReadableStreamDefaultController<Uint8Array>
          let finish!: () => void
          const consumed = new Promise<void>(done => { finish = () => { signal?.removeEventListener('abort', abort); done() } })
          const body = new ReadableStream<Uint8Array>({
            start(controller) { downstream = controller },
            async pull(controller) {
              try {
                const { done, value } = await reader.read()
                if (done) { controller.close(); finish() }
                else controller.enqueue(value)
              } catch (error) { controller.error(error); finish() }
            },
            async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
          })
          abort = () => {
            downstream.error(signal?.reason)
            void reader.cancel(signal?.reason).catch(() => {}).finally(finish)
          }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
          resolve(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }))
          // Keep the slot until EOF/cancel; never replay a body after exposing its bytes.
          await consumed
          return
        } catch (error: any) {
          if (attempt || signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error
          count('retry.agent_call')
          await delay(500, undefined, { signal: signal ?? undefined })
        }
      }
    }).catch(reject)
  })
'''
candidate('保留消费期并发租约，透传模型响应流而非整包缓冲','stream',{'backend/src/agents.ts':[('@provider',provider)]})
candidate('并发额度不足时先排医生请求，再排教练请求','queue',{'backend/src/agents.ts':[('@priority','')]})
candidate('首字前的医学快照和参考资料并行读取','dialogue_parallel',{'backend/src/live.ts':[("""        checks = await this.checks.snapshot(),
        reference = this.record.free_context
          ? await this.medical.reference(
              this.user,
              this.record.free_context.drug,
              history
                .slice(-4)
                .map((m: Doc) => m.text)
                .join('\\n'),
            )
          : undefined""", """        [checks, reference] = await Promise.all([
          this.checks.snapshot(),
          this.record.free_context ? this.medical.reference(this.user, this.record.free_context.drug,
            history.slice(-4).map((m: Doc) => m.text).join('\\n')) : undefined,
        ])""")]})
candidate('首字前的资料验证和评分开关并行读取','dialogue_settings',{'backend/src/live.ts':[("""      await this.validate()
      const scoring = await this.store.transaction(
        this.user.workspace,
        async (tx) => (await workspaceSettings(tx, this.user.workspace)).training_scoring,
        false,
      )""", """      const [, scoring] = await Promise.all([
        this.validate(),
        this.store.transaction(this.user.workspace,
          async tx => (await workspaceSettings(tx, this.user.workspace)).training_scoring, false),
      ])""")]})
candidate('医生发布前的资料验证和医学凭据复核并行','dialogue_publish',{'backend/src/live.ts':[("""        await this.validate()
        const current = structuredClone(checks)
        await this.medical.invalidate(this.user, current)""", """        const current = structuredClone(checks)
        await Promise.all([this.validate(), this.medical.invalidate(this.user, current)])""")]})
skill='''const skillCache = new Map<string, { stamp: string; text: Promise<string> }>()
export async function skill(name: string): Promise<string> {
  assert(/^[a-z][a-z0-9-]+$/.test(name), 500, 'Invalid skill')
  const path = new URL(`${name}/SKILL.md`, skillRoot), info = await stat(path)
  const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
  const cached = skillCache.get(name)
  if (cached?.stamp === stamp) return cached.text
  const text = readFile(path, 'utf8').then(value => value.replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, '').trim())
  skillCache.set(name, { stamp, text })
  void text.catch(() => { if (skillCache.get(name)?.text === text) skillCache.delete(name) })
  return text
}
'''
candidate('按文件修改标识复用技能文本，保留热更新和失败重试','skill',{'backend/src/agents.ts':[("import { readFile } from 'node:fs/promises'","import { readFile, stat } from 'node:fs/promises'"),('@skill',skill)]})
candidate('没有教练专用参考时复用医生和教练的输入序列化','serialize',{'backend/src/agents.ts':[('@serialize','')]})
candidate('实时回应仅克隆最后16条输入，保留全部已响应标识','dialogue_history',{'backend/src/live.ts':[("const history = structuredClone(this.record.messages.filter((m: Doc) => m.final)),","const finalMessages = this.record.messages.filter((m: Doc) => m.final),\n        history = structuredClone(finalMessages.slice(-16)),"),("for (const message of history) if (message.role === 'trainee') this.responded.add(message.id)","for (const message of finalMessages) if (message.role === 'trainee') this.responded.add(message.id)")]})
candidate('无绑定资料时跳过空的材料验证事务','materials_empty',{'backend/src/training.ts':[("export async function checkMaterials(store: Store, user: User, training?: Doc, free?: Doc) {","export async function checkMaterials(store: Store, user: User, training?: Doc, free?: Doc) {\n  if (!training && !free) return")]})
candidate('材料有效性查询省去不参与校验的原文页传输和反序列化','materials',{'backend/src/store.ts':[("async get(tenant: string, kind: string, id: string): Promise<Doc | null> {\n    const rows = await this.execute(\n      'SELECT document FROM platform_entities WHERE tenant_id=? AND kind=? AND id=?',", "async get(tenant: string, kind: string, id: string, withoutPages = false): Promise<Doc | null> {\n    const document = withoutPages\n      ? this.postgres ? \"(document::jsonb - 'pages')::text\" : \"json_remove(document,'$.pages')\"\n      : 'document'\n    const rows = await this.execute(\n      `SELECT ${document} AS document FROM platform_entities WHERE tenant_id=? AND kind=? AND id=?`,")], 'backend/src/training.ts':[("const current = await tx.get(user.workspace, kind, captured.id)","const current = await tx.get(user.workspace, kind, captured.id, true)")]})
candidate('同次材料校验按种类和编号复用读取，逐份校验版本','materials_duplicates',{'backend/src/training.ts':[('@deduplicate','')]})
candidate('同类材料有效性读取并行等待','materials_parallel',{'backend/src/training.ts':[('@parallel_materials','')]})
candidate('参考资料入口只读取实际使用的语料元数据','reference_metadata',{'backend/src/medical.ts':[("const { data } = await this.evidence(u, ''),\n      names =", "const data = await this.load(),\n      names =")]})
candidate('参考产品的独立证据检索并行，保留结果顺序','reference_parallel',{'backend/src/medical.ts':[('@parallel_reference','')]})
candidate('ASR首包改为100ms，后续保持200ms和完整PCM','asr_first',{'backend/src/sessions.ts':[("if (frames.length >= 6400) {","if (frames.length >= (audioBytes === 0 ? 3200 : 6400)) {")]})
candidate('TTS开始通知按原顺序入队后并行等待发送完成','tts_notify',{'backend/src/live.ts':[("""      await this.send({ type: 'response_started', response_id: responseId, message_id: id })
      await this.send({ type: 'tts_state', state: 'speaking' })""", """      await Promise.all([
        this.send({ type: 'response_started', response_id: responseId, message_id: id }),
        this.send({ type: 'tts_state', state: 'speaking' }),
      ])""")]})
candidate('技能前置信息解析使用dotAll等价正则','skill_regex',{'backend/src/agents.ts':[(r'/^---\r?\n[\s\S]*?\r?\n---\r?\n/',r'/^---\r?\n.*?\r?\n---\r?\n/s')]})
candidate('试验医生最大输出预算1600，检查本地首字和质量边界','tokens',{'backend/src/agents.ts':[("{ temperature: models.config.temperature, tokens },","{ temperature: models.config.temperature, tokens: Math.min(tokens, 1600) },")]},quality_gate=False)
candidate('检索候选不可能进入前十时跳过二分插入','retrieve',{'backend/src/training.ts':[("        if (bounded) {\n          let low", "        if (bounded) {\n          if (candidates.length === limit && compare(candidates[candidates.length - 1], candidate) <= 0) continue\n          let low")]})
candidate('有界检索复用已经排序的候选数组','retrieve',{'backend/src/training.ts':[("  return candidates\n    .sort(compare)\n    .slice(0, limit)", "  return (bounded ? candidates : candidates.sort(compare))\n    .slice(0, limit)")]})


def transform(source,before,after):
 if before=='@provider':
  a=source.index('  private providerFetch:');b=source.index('  agent(',a);return source[:a]+after+source[b:]
 if before=='@priority':
  a=source.index('  const runs = [');b=source.index('  const replies = await Promise.allSettled(runs)',a)
  return source[:a]+'''  const doctorRun = doctor?.reply(JSON.stringify(record), signal, budget).then(async reply => {
    const text = parseDoctor(JSON.parse(reply.text))
    if (options.onDoctor) await options.onDoctor(text, reply.usage)
    return reply
  })
  const runs = [
    coach.reply(JSON.stringify({ ...record, ...(options.reference_context ? { reference_context: options.reference_context } : {}) }),
      signal, speak ? budget - 10 : budget),
    ...(doctorRun ? [doctorRun] : []),
  ]
'''+source[b:]
 if before=='@skill':
  a=source.index('export async function skill(');b=source.index('const routes:',a);return source[:a]+after+source[b:]
 if before=='@serialize':
  anchor='  const doctorRun =' if '  const doctorRun =' in source else '  const runs = ['
  source=source.replace(anchor,'  const input = JSON.stringify(record)\n'+anchor,1)
  source=source.replace('JSON.stringify(record), signal, budget','input, signal, budget')
  compact="JSON.stringify({ ...record, ...(options.reference_context ? { reference_context: options.reference_context } : {}) })"
  full="""JSON.stringify({
        ...record,
        ...(options.reference_context ? { reference_context: options.reference_context } : {}),
      })"""
  target=compact if compact in source else full
  assert target in source
  return source.replace(target,'options.reference_context ? JSON.stringify({ ...record, reference_context: options.reference_context }) : input',1)
 if before=='@deduplicate':
  anchor="      if (training)\n        for (const [kind, items]"
  source=source.replace(anchor,"      const loaded = new Map<string, Doc | null>()\n"+anchor,1)
  target="const current = await tx.get(user.workspace, kind, captured.id, true)" if 'captured.id, true)' in source else "const current = await tx.get(user.workspace, kind, captured.id)"
  tail=', true' if 'captured.id, true)' in source else ''
  return source.replace(target,f"const key = `${{kind}}:${{captured.id}}`\n            if (!loaded.has(key)) loaded.set(key, await tx.get(user.workspace, kind, captured.id{tail}))\n            const current = loaded.get(key)",1)
 if before=='@parallel_materials':
  a=source.index('      if (training)\n        for (const [kind, items]');b=source.index('\n    },\n    false,\n  )',a)
  block=source[a:b]
  block=block.replace('          for (const captured of items) {','          await Promise.all(items.map(async captured => {',1)
  end=block.rfind('          }\n        }');assert end>=0
  block=block[:end]+block[end:].replace('          }\n        }','          }))\n        }',1)
  return source[:a]+block+source[b:]
 if before=='@parallel_reference':
  source=source.replace('    for (const product of [...selected, ...peers].slice(0, 4)) {','    const groups = await Promise.all([...selected, ...peers].slice(0, 4).map(async product => {',1)
  source=source.replace('''      evidence.push(...found)
      if (!found.length)
        gaps.push({ product: product.name, reason: '缺少当前有效审核的相关原文，不能作医学比较。' })
    }
    return { version: data.version, evidence, gaps }''','''      return { product, found }
    }))
    for (const { product, found } of groups) {
      evidence.push(...found)
      if (!found.length) gaps.push({ product: product.name, reason: '缺少当前有效审核的相关原文，不能作医学比较。' })
    }
    return { version: data.version, evidence, gaps }''',1)
  return source
 assert source.count(before)==1,(before,source.count(before))
 return source.replace(before,after,1)

def snapshot(destination):
    for part in ['backend', 'frontend']:
        dst = destination / part
        dst.mkdir(parents=True)
        shutil.copytree(ROOT / part / 'src', dst / 'src', ignore=shutil.ignore_patterns('assets'))
        (dst / 'node_modules').symlink_to(ROOT / part / 'node_modules', target_is_directory=True)
        if part == 'backend':
            for name in ['resources', 'migrations', 'parsers']:
                (dst / name).symlink_to(ROOT / part / name, target_is_directory=True)


def measure(folder, case, small=False):
    command = ['node', '--experimental-transform-types', '--expose-gc', str(BENCH), '--root', str(folder / 'backend'), '--case', case, '--samples', '5']
    if small:
        command.append('--small')
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(result.stdout.strip().splitlines()[-1])


def summarize(rows):
    values = {label: [row['measurement']['median_ms'] for row in rows if row['version'] == label] for label in ['A', 'B']}
    before, after = statistics.median(values['A']), statistics.median(values['B'])
    return dict(before_ms=before, after_ms=after, improvement_percent=(before-after)/before*100,
                paired_percent=[(a-b)/a*100 for a,b in zip(values['A'], values['B'])])


if __name__=='__main__':
 assert len(CANDIDATES)==20
 results=[]
 for index,item in enumerate(CANDIDATES,1):
  originals={file:(ROOT/file).read_text() for file in item['changes']}
  a=RUN/f'round-{index:02}-A';b=RUN/f'round-{index:02}-B'
  snapshot(a)
  accepted=False
  try:
   patch=''
   for file,changes in item['changes'].items():
    value=originals[file]
    for before,after in changes:value=transform(value,before,after)
    assert value!=originals[file],(index,'no change')
    (ROOT/file).write_text(value)
    patch+=''.join(difflib.unified_diff(originals[file].splitlines(True),value.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
   (EVIDENCE/f'round-{index:02}.patch').write_text(patch)
   snapshot(b)
   large=[dict(version=v,measurement=measure(a if v=='A' else b,item['case'])) for v in 'ABBAAB']
   small=[dict(version=v,measurement=measure(a if v=='A' else b,item['case'],True)) for v in 'ABBA']
   ls=summarize(large);ss=summarize(small)
   equal=all(len({r['measurement']['output_sha256'] for r in values})==1 for values in [large,small])
   stable=sum(p>=5 for p in ls['paired_percent'])>=2
   small_ok=ss['improvement_percent']>=-15 or ss['after_ms']-ss['before_ms']<.5
   tail={v:statistics.median(statistics.median(r['measurement']['complete_ms']) for r in large if r['version']==v) for v in 'AB'}
   tail_ok=tail['B']<=tail['A']*1.1 or tail['B']-tail['A']<1
   real_control=None;real_ok=True
   if index==14:
    controls=[dict(version=v,measurement=measure(a if v=='A' else b,'reference_real')) for v in 'ABBAAB']
    real_control=dict(summary=summarize(controls),runs=controls)
    assert len({r['measurement']['output_sha256'] for r in controls})==1
    real_ok=real_control['summary']['improvement_percent']>=5 and sum(p>=5 for p in real_control['summary']['paired_percent'])>=2
   accepted=equal and ls['improvement_percent']>=5 and stable and small_ok and tail_ok and real_ok and item.get('quality_gate',True)
   reason='retained' if accepted else 'real SQLite control: insufficient or unstable improvement' if not real_ok else 'quality gate: token budget needs live quality validation' if not item.get('quality_gate',True) else 'output mismatch' if not equal else 'tail latency regression' if not tail_ok else 'small-load regression' if not small_ok else 'insufficient or unstable improvement'
   result=dict(round=index,title=item['title'],case=item['case'],accepted=accepted,equivalent=equal,reason=reason,large=ls,small=ss,tail=tail,large_runs=large,small_runs=small)
   if real_control:result['real_control']=real_control
   results.append(result)
   (EVIDENCE/f'round-{index:02}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
   (EVIDENCE/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
   print(f"{index:02} {'KEEP' if accepted else 'REVERT'} {ls['before_ms']:.4f}->{ls['after_ms']:.4f}ms ({ls['improvement_percent']:+.1f}%) {item['title']}",flush=True)
  finally:
   if not accepted:
    for file,source in originals.items():(ROOT/file).write_text(source)
 snapshot(RUN/'final')
 print(f'Completed 20 independent candidates; retained {sum(r["accepted"] for r in results)}.',flush=True)
