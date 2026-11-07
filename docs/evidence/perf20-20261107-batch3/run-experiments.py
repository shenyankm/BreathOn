"""Run 20 isolated, sequential A/B candidates against the current source tree.
No credentials/provider calls; candidate patches and all measurements are retained.
"""
import difflib
import json
from pathlib import Path
import shutil
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
RUN = Path('/tmp/evispeak-perf20-batch3-root').read_text().strip()
RUN = Path(RUN)
BENCH = ROOT / 'backend/benchmarks/performance-twenty.ts'
CANDIDATES = []

def candidate(title, case, file, replacements):
    CANDIDATES.append(dict(title=title, case=case, file=file, replacements=replacements))

candidate('活动摘要从末尾查找最终复盘，避免复制整段辅导历史', 'activity', 'backend/src/store.ts', [
("[...(record.coaching ?? [])].reverse().find((row: Doc) => row.final_report)", "(record.coaching ?? []).findLast((row: Doc) => row.final_report)")])
candidate('活动摘要单次收集学员消息和修剪后的文本', 'activity_messages', 'backend/src/store.ts', [
("""  const trainee = (record.messages ?? []).filter(
      (m: Doc) => m.role === 'trainee' && m.text?.trim(),
    ),
    text = trainee.map((m: Doc) => m.text.trim()).join('\\n')""", """  const trainee: Doc[] = [], texts: string[] = []
  for (const message of record.messages ?? []) {
    const value = message.role === 'trainee' ? message.text?.trim() : ''
    if (value) { trainee.push(message); texts.push(value) }
  }
  const text = texts.join('\\n')""")])
candidate('人工评分覆盖直接逆序遍历，不复制点评数组', 'learning_reviews', 'backend/src/learning.ts', [
("for (const review of [...reviews].reverse()) for (const change of review.overrides ?? [])", "for (let i = reviews.length - 1; i >= 0; i--) for (const change of reviews[i].overrides ?? [])")])
candidate('人工评分覆盖按维度建立首项索引', 'learning_reviews', 'backend/src/learning.ts', [
("  for (let i = reviews.length - 1;", "  const byKey = new Map<string, Doc>()\n  for (const dimension of dimensions) if (!byKey.has(dimension.key)) byKey.set(dimension.key, dimension)\n  for (let i = reviews.length - 1;"),
("const dimension = dimensions.find(row => row.key === change.key)", "const dimension = byKey.get(change.key)")])
candidate('学习统计按记录分组点评，避免逐记录扫描全部点评', 'learning_outcomes', 'backend/src/learning.ts', [
("    const viewed = new Map(data.views.map(row => [row.record_id, row.created_at]))", """    const reviewsByRecord = new Map<string, Doc[]>()
    for (const review of data.reviews) {
      const group = reviewsByRecord.get(review.record_id)
      if (group) group.push(review)
      else reviewsByRecord.set(review.record_id, [review])
    }
    const viewed = new Map(data.views.map(row => [row.record_id, row.created_at]))"""),
("reviewedDimensions(record, data.reviews.filter(review => review.record_id === record.id))", "reviewedDimensions(record, reviewsByRecord.get(record.id) ?? [])")])
candidate('学习统计复用本次有效记录集合，避免重复摘要和指纹计算', 'learning_outcomes', 'backend/src/learning.ts', [
("    const baselines = new Map(records.map(record => [record.id, record]))", "    const validRecords = records.filter(record => activity(record).valid)\n    const baselines = new Map(records.map(record => [record.id, record]))"),
("for (const record of records.filter(record => activity(record).valid))", "for (const record of validRecords)"),
("valid_attempts: records.filter(record => activity(record).valid).length", "valid_attempts: validRecords.length")])
candidate('学习统计一次遍历计算四类任务数量', 'learning_outcomes', 'backend/src/learning.ts', [
("    const today = Math.floor(Date.now() / 86400000)", """    let needsPractice = 0, needsVerification = 0, awaitingReview = 0, verified = 0
    for (const plan of data.plans) {
      if (plan.status === 'assigned') needsPractice++
      if (plan.status === 'awaiting_verification') needsVerification++
      if (plan.status === 'awaiting_review') awaitingReview++
      if (plan.learning_status === 'verified') verified++
    }
    const today = Math.floor(Date.now() / 86400000)"""),
("data.plans.filter(plan => plan.status === 'assigned').length", "needsPractice"),
("data.plans.filter(plan => plan.status === 'awaiting_verification').length", "needsVerification"),
("data.plans.filter(plan => plan.status === 'awaiting_review').length", "awaitingReview"),
("data.plans.filter(plan => plan.learning_status === 'verified').length", "verified")])
candidate('难题列表按原案例索引已发布场景', 'learning_challenges', 'backend/src/learning.ts', [
("    return visits.map(visit =>", """    const scenesByCase = new Map<string, Doc[]>()
    for (const scene of scenes) {
      const id = scene.generation?.case?.id
      if (!id) continue
      const group = scenesByCase.get(id)
      if (group) group.push(scene)
      else scenesByCase.set(id, [scene])
    }
    return visits.map(visit =>"""),
("scenes.filter(scene => scene.generation?.case?.id && scene.generation.case.id === visit.review?.case_id)", "(scenesByCase.get(visit.review?.case_id) ?? [])")])
candidate('目标行为核对每条引文只归一化一次', 'learning_observed', 'backend/src/learning.ts', [
("""(dimension.utterances ?? []).some((quote: Doc) => typeof quote.quote === 'string' && normalize(quote.quote).length >= 6 &&
      record.messages.some((message: Doc) => message.id === quote.message_id && message.role === 'trainee' && message.final &&
        normalize(message.text).includes(normalize(quote.quote))))""", """(dimension.utterances ?? []).some((quote: Doc) => {
      if (typeof quote.quote !== 'string') return false
      const text = normalize(quote.quote)
      return text.length >= 6 && record.messages.some((message: Doc) => message.id === quote.message_id &&
        message.role === 'trainee' && message.final && normalize(message.text).includes(text))
    })""")])
candidate('前端复盘单次选择最弱有效维度，保留同分顺序', 'frontend_next', 'frontend/src/lib/learning.ts', [
("coach?.assessment?.dimensions.filter(row => typeof row.score==='number' && Number.isInteger(row.score) && row.score>=0 && row.score<=4).sort((a, b) => a.score! - b.score!)[0]", """coach?.assessment?.dimensions.reduce<NonNullable<LiveCoach['assessment']>['dimensions'][number] | undefined>((best, row) =>
    typeof row.score === 'number' && Number.isInteger(row.score) && row.score >= 0 && row.score <= 4 &&
    (!best || row.score < best.score!) ? row : best, undefined)""")])
candidate('前端复盘引文长度和原话核对复用归一化结果', 'frontend_next', 'frontend/src/lib/learning.ts', [
("""dimension?.utterances.find(quote => compact(quote.quote).length>=6 && record.messages.some(message => message.id === quote.message_id &&
    message.role === 'trainee' && message.final && compact(message.text).includes(compact(quote.quote))))""", """dimension?.utterances.find(quote => {
    const text = compact(quote.quote)
    return text.length >= 6 && record.messages.some(message => message.id === quote.message_id &&
      message.role === 'trainee' && message.final && compact(message.text).includes(text))
  })""")])
candidate('医学引用核对按块编号建立首项索引', 'citations', 'backend/src/medical.ts', [
("  return parts.map((sentence, index) => {", "  const chunks = new Map<string, Doc>()\n  for (const chunk of evidence) if (!chunks.has(chunk.id)) chunks.set(chunk.id, chunk)\n  return parts.map((sentence, index) => {"),
("evidence.find((e) => e.id === citation?.chunk_id)", "chunks.get(citation?.chunk_id)")])
candidate('评分卡重复原话核对按需缓存本次学员文本', 'summary_quotes', 'backend/src/medical.ts', [
("""    validQuote = (row: Doc) =>""", """    normalizedTrainees = new Map<string, string>(),
    sourceText = (id: string) => {
      let text = normalizedTrainees.get(id)
      if (text === undefined) {
        text = normalize(trainees.get(id)!)
        normalizedTrainees.set(id, text)
      }
      return text
    },
    validQuote = (row: Doc) =>"""),
("normalize(trainees.get(row.message_id)!).includes(normalize(row.quote))", "sourceText(row.message_id).includes(normalize(row.quote))")])
candidate('字段投影直接写入对象，保留原型特殊键和空值语义', 'pick', 'backend/src/core.ts', [
("""export const pick = (row: Doc, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))""", """export const pick = (row: Doc, keys: string[]) => {
  const result: Doc = {}
  for (const key of keys) {
    const value = row[key] ?? null
    if (key === '__proto__') Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
    else result[key] = value
  }
  return result
}""")])
candidate('兼容指纹序列化的对象字段使用循环收集', 'canonical', 'backend/src/core.ts', [
("""  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${canonical(value[key])}`)
      .join(', ')}}`""", """  if (value && typeof value === 'object') {
    const fields: string[] = []
    for (const key of Object.keys(value).sort()) fields.push(`${JSON.stringify(key)}: ${canonical(value[key])}`)
    return `{${fields.join(', ')}}`
  }""")])
candidate('技能路由逆序收集最新角色消息，省去整段复制和过滤', 'skills', 'backend/src/agents.ts', [
("""  const roles = new Set<string>(),
    selected = speak
      ? [...messages].reverse().filter((m) => {
          if (roles.has(m.role)) return false
          roles.add(m.role)
          return true
        })
      : messages""", """  const roles = new Set<string>()
  let selected = messages
  if (speak) {
    selected = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!roles.has(message.role)) { roles.add(message.role); selected.push(message) }
    }
  }""")])
candidate('交互摘要直接查找最后采集结束事件', 'interactions', 'backend/src/agents.ts', [
("[...interactions].reverse().find((e) => e.type === 'capture_end')", "interactions.findLast((e) => e.type === 'capture_end')")])
candidate('交互摘要直接累计打断次数，避免过滤数组', 'interactions', 'backend/src/agents.ts', [
("interactions.filter((e) => e.type === 'manual_interrupt').length", "interactions.reduce((sum, e) => sum + (e.type === 'manual_interrupt' ? 1 : 0), 0)")])
candidate('空检索词时跳过资料块转小写', 'retrieve_blank', 'backend/src/training.ts', [
("lower = text.toLowerCase()", "lower = terms.length ? text.toLowerCase() : ''")])
candidate('音频解码复用无状态 Base64 正则对象', 'base64', 'backend/src/voice-protocol.ts', [
("export function decode64(value: unknown): Buffer {", "const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/\nexport function decode64(value: unknown): Buffer {"),
("/^[A-Za-z0-9+/]*={0,2}$/.test(value)", "base64Pattern.test(value)")])


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
    command = ['node', '--experimental-transform-types', '--expose-gc', str(BENCH), '--root', str(folder / 'backend'), '--case', case, '--samples', '7']
    if small:
        command.append('--small')
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(result.stdout.strip().splitlines()[-1])


def summarize(rows):
    values = {label: [row['measurement']['median_ms'] for row in rows if row['version'] == label] for label in ['A', 'B']}
    before, after = statistics.median(values['A']), statistics.median(values['B'])
    return dict(before_ms=before, after_ms=after, improvement_percent=(before-after)/before*100,
                paired_percent=[(a-b)/a*100 for a,b in zip(values['A'], values['B'])])


if __name__ == '__main__':
    assert len(CANDIDATES) == 20
    results=[]
    for index, experiment in enumerate(CANDIDATES, 1):
        path = ROOT / experiment['file']; original = path.read_text(); modified = original
        # A reversed-loop candidate can be rejected, so candidate 4 works against either source form.
        replacements = experiment['replacements']
        if index == 4 and 'for (let i = reviews.length - 1;' not in modified:
            replacements = [("  for (const review of [...reviews].reverse())", "  const byKey = new Map<string, Doc>()\n  for (const dimension of dimensions) if (!byKey.has(dimension.key)) byKey.set(dimension.key, dimension)\n  for (const review of [...reviews].reverse())"), replacements[1]]
        for before, after in replacements:
            assert modified.count(before)==1, (index, before, modified.count(before))
            modified = modified.replace(before, after, 1)
        before_dir = RUN / f'round-{index:02}-A'; after_dir = RUN / f'round-{index:02}-B'
        snapshot(before_dir)
        path.write_text(modified)
        patch=''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile='a/'+experiment['file'],tofile='b/'+experiment['file']))
        (EVIDENCE / f'round-{index:02}.patch').write_text(patch)
        accepted=False
        try:
            snapshot(after_dir)
            large=[]; control=[]
            for version in 'ABBAAB':
                large.append(dict(version=version,measurement=measure(before_dir if version=='A' else after_dir,experiment['case'])))
            for version in 'ABBA':
                control.append(dict(version=version,measurement=measure(before_dir if version=='A' else after_dir,experiment['case'],True)))
            equivalent = len({row['measurement']['output_sha256'] for row in large})==1 and len({row['measurement']['output_sha256'] for row in control})==1
            large_summary=summarize(large); small_summary=summarize(control)
            stable=sum(p>=5 for p in large_summary['paired_percent'])>=2
            small_ok=small_summary['improvement_percent']>=-10 or small_summary['after_ms']-small_summary['before_ms']<0.001
            accepted=equivalent and large_summary['improvement_percent']>=5 and stable and small_ok
            result=dict(round=index,title=experiment['title'],case=experiment['case'],file=experiment['file'],accepted=accepted,equivalent=equivalent,
                        large=large_summary,small=small_summary,large_runs=large,small_runs=control,
                        reason='retained' if accepted else 'output mismatch' if not equivalent else 'small-load regression' if not small_ok else 'insufficient or unstable improvement')
            results.append(result)
            (EVIDENCE / f'round-{index:02}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
            (EVIDENCE / 'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
            print(f"{index:02} {'KEEP' if accepted else 'REVERT'} {large_summary['before_ms']:.6f}->{large_summary['after_ms']:.6f}ms ({large_summary['improvement_percent']:+.1f}%) {experiment['title']}",flush=True)
        finally:
            if not accepted:
                path.write_text(original)
    snapshot(RUN/'final')
    print(f'Completed {len(results)} independent candidates; retained {sum(row["accepted"] for row in results)}.',flush=True)
