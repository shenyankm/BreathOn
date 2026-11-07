"""20 new candidates from the already optimized dirty tree. Serial isolated A/B."""
from pathlib import Path
import json,statistics,difflib,subprocess,shutil
ROOT=Path(__file__).resolve().parents[3]
EVIDENCE=Path(__file__).resolve().parent
RUN=Path(Path('/tmp/evispeak-latency20b2-root').read_text().strip())
BENCH=ROOT/'backend/benchmarks/latency-twenty-batch2.ts'
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


C=[]
def c(title,case,file,before,after,**extra):C.append(dict(title=title,case=case,changes={file:[(before,after)]},**extra))
c('模型前置快照、参考、资料校验、评分读取同时启动','dialogue_parallel','backend/src/live.ts',"""          this.record.free_context ? this.medical.reference(this.user, this.record.free_context.drug,
            history.slice(-4).map((m: Doc) => m.text).join('\\n')) : undefined,
        ])
      const [, scoring] = await Promise.all([
        this.validate(),
        this.store.transaction(this.user.workspace,
          async tx => (await workspaceSettings(tx, this.user.workspace)).training_scoring, false),
      ])""","""          this.record.free_context ? this.medical.reference(this.user, this.record.free_context.drug,
            history.slice(-4).map((m: Doc) => m.text).join('\\n')) : undefined,
          this.validate(),
          this.store.transaction(this.user.workspace,
            async tx => (await workspaceSettings(tx, this.user.workspace)).training_scoring, false),
        ])""")
# The Promise tuple keeps the original checks/reference positions; scoring is position 4.
C[0]['changes']['backend/src/live.ts'].insert(0,('[checks, reference] = await Promise.all([','[checks, reference, , scoring] = await Promise.all(['))
c('一次参考查询复用同一语料和审核快照，发布时仍重新校验','med_reference','backend/src/medical.ts','@prepare','')
c('医学检索并行读取语料和审核资料','med_evidence','backend/src/medical.ts','@parallel_prepare','')
c('检索源元数据移到分块循环之外','med_evidence','backend/src/medical.ts','@metadata','')
c('查询年份只解析一次','med_evidence','backend/src/medical.ts',"      background = compact(context),","      background = compact(context),\n      years = text.match(/\\b20\\d{2}\\b/g) ?? [],")
C[-1]['changes']['backend/src/medical.ts'].append(("year = (text.match(/\\b20\\d{2}\\b/g) ?? []).some((year) =>","year = years.some((year) =>"))
c('查询词权重只计算一次','med_evidence','backend/src/medical.ts',"      ranked: Doc[] = []","      weighted = tokens.map(token => [token, 1 + Math.min(token.length, 12) / 12] as const),\n      ranked: Doc[] = []")
C[-1]['changes']['backend/src/medical.ts'].append(("tokens.reduce(\n              (n, t) => n + (lower.includes(t) ? 1 + Math.min(t.length, 12) / 12 : 0),","weighted.reduce(\n              (n, [t, weight]) => n + (lower.includes(t) ? weight : 0),"))
c('已有12条有效检索结果后停止扫描排序结果','med_evidence','backend/src/medical.ts','@rows','')
c('同次多产品检索复用原文块规范化结果','med_reference','backend/src/medical.ts','@body_cache','')
c('事实命中两个查询词即停止计数','med_evidence','backend/src/medical.ts',"return tokens.filter((t) => claim.includes(t)).length >= 2","let count = 0\n              return tokens.some(t => claim.includes(t) && ++count >= 2)")
c('无空白原文跳过规范化替换','med_evidence','backend/src/medical.ts',"const compact = (text: string) => normalize(text).toLowerCase()","const compact = (text: string) => (/\\s/u.test(text) ? normalize(text) : text).toLowerCase()")
c('隐私检查复用不带状态的编译正则','privacy','backend/src/agents.ts','@privacy','')
c('TTS有足够播放缓冲时跳过零毫秒定时器','tts_notify','backend/src/voice-protocol.ts',"""          await delay(Math.max(0, bytes / 48 - (Date.now() - started) - 500), undefined, {
            signal: combined,
          })""","""          const wait = bytes / 48 - (Date.now() - started) - 500
          if (wait > 0) await delay(wait, undefined, { signal: combined })
          combined.throwIfAborted()""")
c('TTS文本和结束事件按顺序提交后并行等待写入','tts_notify','backend/src/voice-protocol.ts',"""    await write(200, { event: 200, req_params: { ...params, text } }, id)
    await write(102, {}, id)""","""    await Promise.all([
      write(200, { event: 200, req_params: { ...params, text } }, id),
      write(102, {}, id),
    ])""")
c('ASR压缩等级1试验并检查传输体积代价','asr_packet','backend/src/voice-protocol.ts','const body = gzipSync(payload)','const body = gzipSync(payload, { level: 1 })',quality_gate=False)
c('ASR协议头一次分配并复制压缩正文','asr_packet','backend/src/voice-protocol.ts',"""  return Buffer.concat([
    Buffer.from([0x11, (audio ? 0x20 : 0x10) | (final ? 2 : 0), audio ? 1 : 0x11, 0]),
    u32(body.length),
    body,
  ])""","""  const packet = Buffer.allocUnsafe(8 + body.length)
  packet[0] = 0x11
  packet[1] = (audio ? 0x20 : 0x10) | (final ? 2 : 0)
  packet[2] = audio ? 1 : 0x11
  packet[3] = 0
  packet.writeUInt32BE(body.length, 4)
  body.copy(packet, 8)
  return packet""")
c('TTS协议头一次分配并复制会话与正文','tts_packet','backend/src/voice-protocol.ts','@tts_packet','')
c('麦克风授权后并行恢复音频和加载采集模块','browser_open','frontend/src/lib/audio/browser-audio.ts',"""    await context.resume()
    await context.audioWorklet.addModule(new URL('./capture.worklet.js', import.meta.url).href)""","""    await Promise.all([
      context.resume(),
      context.audioWorklet.addModule(new URL('./capture.worklet.js', import.meta.url).href),
    ])""")
c('PCM16符号扩展使用等价位移','browser_decode','frontend/src/lib/audio/browser-audio.ts',"samples[i] = (value >= 32768 ? value - 65536 : value) / 32768","samples[i] = (value << 16 >> 16) / 32768")
c('采集帧base64编码逐字节构造字符串','browser_encode','frontend/src/lib/audio/browser-audio.ts',"  return btoa(String.fromCharCode(...new Uint8Array(buffer)))","  let bytes = ''\n  for (const value of new Uint8Array(buffer)) bytes += String.fromCharCode(value)\n  return btoa(bytes)")
c('复用已验证技能名对应的文件URL','skill','backend/src/agents.ts',"const skillCache = new Map<string, { stamp: string; text: Promise<string> }>()","const skillCache = new Map<string, { stamp: string; text: Promise<string> }>()\nconst skillPaths = new Map<string, URL>()")
C[-1]['changes']['backend/src/agents.ts'].append(("  const path = new URL(`${name}/SKILL.md`, skillRoot), info = await stat(path)","  const path = skillPaths.get(name) ?? new URL(`${name}/SKILL.md`, skillRoot)\n  skillPaths.set(name, path)\n  const info = await stat(path)"))

def transform(s,b,a):
 if b=='@prepare':
  start=s.index('  async evidence(');prep=s.index('    const data = await this.load(),',start);rank=s.index('    if (!text.trim()',prep)
  block=s[prep:rank].replace('const data = await this.load(),','const corpus = data ?? await this.load(),',1).replace('data.sources','corpus.sources')
  header='''  private async prepareEvidence(u: User, data?: Doc) {
'''
  new=header+block+'''    return { data: corpus, approvals, sources: [...corpus.sources, ...derived] }
  }
  async evidence(u: User, text: string, context = '') {
    return this.rankEvidence(await this.prepareEvidence(u), text, context)
  }
  private rankEvidence(prepared: { data: Doc; approvals: Map<string, Doc>; sources: Doc[] }, text: string, context = '') {
    const { data, approvals, sources } = prepared
'''
  s=s[:start]+new+s[rank:]
  s=s.replace('sources: [...data.sources, ...derived]','sources',1)
  s=s.replace('      ranked: Doc[] = [],\n      sources = [...data.sources, ...derived]','      ranked: Doc[] = []',1)
  s=s.replace("    for (const product of [...selected, ...peers].slice(0, 4)) {","    const products = [...selected, ...peers].slice(0, 4)\n    const prepared = products.length ? await this.prepareEvidence(u, data) : undefined\n    for (const product of products) {",1)
  s=s.replace("(await this.evidence(u, text + ' ' + product.brand)).rows","this.rankEvidence(prepared!, text + ' ' + product.brand).rows",1)
  return s
 if b=='@parallel_prepare':
  before="""    const corpus = data ?? await this.load(),
      documents = await this.store.transaction(
        u.workspace,
        async (tx) => (await tx.list(u.workspace, 'content')).filter(usable),
        false,
      ),"""
  after="""    const [corpus, documents] = await Promise.all([
      data ?? this.load(),
      this.store.transaction(u.workspace,
        async tx => (await tx.list(u.workspace, 'content')).filter(usable), false),
    ]),"""
  assert before in s;return s.replace(before,after,1)
 if b=='@metadata':
  anchor='    for (const source of sources) {'
  assert s.count(anchor)==1;s=s.replace(anchor,anchor+'\n      const { pages, original_path, ...metadata } = source',1)
  return s.replace('            const { pages, original_path, ...metadata } = source\n','',1)
 if b=='@rows':
  x=s.index('    const per = new Map<string, number>(),');y=s.index('    return { data, approvals, rows, sources }',x)
  return s[:x]+'''    const per = new Map<string, number>(), rows: Doc[] = []
    for (const row of ranked) {
      const count = per.get(row.source_id) ?? 0
      if (count >= 4) continue
      per.set(row.source_id, count + 1)
      rows.push(row)
      if (rows.length === 12) break
    }
'''+s[y:]
 if b=='@body_cache':
  s=s.replace('return { data: corpus, approvals, sources: [...corpus.sources, ...derived] }','return { data: corpus, approvals, sources: [...corpus.sources, ...derived], normalized: new Map<string, string>() }',1)
  s=s.replace('sources: Doc[] }, text: string','sources: Doc[]; normalized: Map<string, string> }, text: string',1)
  s=s.replace('const { data, approvals, sources } = prepared','const { data, approvals, sources, normalized } = prepared',1)
  return s.replace('            lower = compact(body)','            lower = normalized.get(body) ?? compact(body)\n          normalized.set(body, lower)',1)
 if b=='@privacy':
  x=s.index('export function personalDataKind(');y=s.index('  return checks.find(',x)
  block=s[x:y];header=block[:block.index('  const checks:')];checks=block[block.index('  const checks:'):]
  return s[:x]+checks.replace('  const checks:','const checks:',1)+header+s[y:]
 if b=='@tts_packet':
  x=s.index('  return Buffer.concat([',s.index('export function ttsRequest'));y=s.index('\n}',x)
  return s[:x]+'''  const connection = event === 1 || event === 2
  const header = connection ? 12 : 16 + identity.length
  const packet = Buffer.allocUnsafe(header + data.length)
  packet.writeUInt32BE(0x11141000, 0)
  packet.writeUInt32BE(event, 4)
  if (!connection) {
    packet.writeUInt32BE(identity.length, 8)
    identity.copy(packet, 12)
  }
  packet.writeUInt32BE(data.length, header - 4)
  data.copy(packet, header)
  return packet'''+s[y:]
 assert s.count(b)==1,(b,s.count(b));return s.replace(b,a,1)

if __name__=='__main__':
 assert len(C)==20
 if not (RUN/'initial').exists():snapshot(RUN/'initial')
 results=json.loads((EVIDENCE/'results.json').read_text()) if (EVIDENCE/'results.json').exists() else []
 for index,item in enumerate(C,1):
  if index<=len(results):continue
  originals={f:(ROOT/f).read_text() for f in item['changes']};A=RUN/f'round-{index:02}-A';B=RUN/f'round-{index:02}-B';snapshot(A);accepted=False
  try:
   patch=''
   for f,changes in item['changes'].items():
    s=originals[f]
    for b,a in changes:s=transform(s,b,a)
    assert s!=originals[f]
    (ROOT/f).write_text(s)
    patch+=''.join(difflib.unified_diff(originals[f].splitlines(True),s.splitlines(True),fromfile='a/'+f,tofile='b/'+f))
   (EVIDENCE/f'round-{index:02}.patch').write_text(patch);snapshot(B)
   large=[dict(version=v,measurement=measure(A if v=='A' else B,item['case'])) for v in 'ABBAAB']
   small=[dict(version=v,measurement=measure(A if v=='A' else B,item['case'],True)) for v in 'ABBA']
   ls=summarize(large);ss=summarize(small)
   equal=all(len({r['measurement']['output_sha256'] for r in group})==1 for group in [large,small])
   stable=sum(p>=5 for p in ls['paired_percent'])>=2
   small_ok=ss['improvement_percent']>=-15 or ss['after_ms']-ss['before_ms']<.5
   tail={v:statistics.median(statistics.median(r['measurement']['complete_ms']) for r in large if r['version']==v) for v in 'AB'}
   tail_ok=tail['B']<=tail['A']*1.1 or tail['B']-tail['A']<1
   accepted=equal and ls['improvement_percent']>=5 and stable and small_ok and tail_ok and item.get('quality_gate',True)
   reason='retained' if accepted else 'compression ratio and live transport need validation' if not item.get('quality_gate',True) else 'output mismatch' if not equal else 'tail regression' if not tail_ok else 'small-load regression' if not small_ok else 'insufficient or unstable improvement'
   r=dict(round=index,title=item['title'],case=item['case'],accepted=accepted,equivalent=equal,reason=reason,large=ls,small=ss,tail=tail,large_runs=large,small_runs=small)
   results.append(r);(EVIDENCE/f'round-{index:02}.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');(EVIDENCE/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
   print(f'{index:02} {"KEEP" if accepted else "REVERT"} {ls["before_ms"]:.5f}->{ls["after_ms"]:.5f}ms ({ls["improvement_percent"]:+.1f}%) {item["title"]}',flush=True)
  except Exception as error:
   (EVIDENCE/f'round-{index:02}-error.txt').write_text(str(error))
   raise
  finally:
   if not accepted:
    for f,s in originals.items():(ROOT/f).write_text(s)
 snapshot(RUN/'final')
 (EVIDENCE/'measurement-benchmark.ts').write_text(BENCH.read_text())
 print('Completed 20 fresh candidates; kept '+str(sum(r['accepted'] for r in results)),flush=True)
