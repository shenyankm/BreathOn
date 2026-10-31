"""Deterministic navigation around source-bound, persistent LLM compilations."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from ..storage.records import write_private

SCHEMA = '''# 医学 Wiki 规则

## 三层与信任边界
- raw/sources/<source_id>/<sha256> 保存不可变原件；新版本另存，versions 保存历史元数据。
- corpus.json 是结构化检索快照；wiki/sources 是带页码的原文阅读副本，wiki/entities 是产品与编译要点，wiki/comparisons 是关联与比较边界。
- AGENTS.md 与本文件规定 ingest / query / lint；wiki/index.md 是内容目录，wiki/log.md 仅追加。
- 每份来源保留 URL、SHA-256、抓取时间、版本、地区、质量；版本未知必须标明，不得以抓取日替代修订日。
- 每条编译事实绑定 source_id、page、quote、sha256；摘要不能替代原文。自动归档与编译一律 pending，不自动审批。

## 业务关系与引用
- 本公司目录和竞品目录分开。竞品按品牌/制剂/地区建实体，compares_with 仅为训练话题关联，不是可替换或优效证据。
- 比较须分别核对适应症、人群、线次、联合方案、终点、随访、地区与版本；国外说明书不能证明中国获批，跨试验数值不能推出头对头优劣。
- query 先读 index，再读实体/比较页，最终回到原文。实时教练只接收当前有效医学审核对应的原文片段与审批凭据；未审核仅报告资料缺口。
- 医生背景用于角色与沟通风格，不是药品证据；患者、账号和私人练习记录不得进入共享 Wiki。

## 维护
- ingest 保留旧原件与版本，重建来源和实体的双向链接；保留已有编译事实，资料变更后重新编译并校验引用。
- lint 检查断链、孤立页、来源哈希、编译引用和资料缺口；冲突在相关条目中列为待核实，不静默覆盖为新事实。
- 每次导入、编译和维护向 log 追加时间、范围和缺口；不得删旧日志或把新抓取当成人工审核。
'''


def markdown(meta, body):
    return '---\n'+'\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k,v in meta.items())+'\n---\n\n'+'\n'.join(line.rstrip() for line in body.splitlines()).rstrip()+'\n'


def render_wiki(root, data, operation='maintain'):
    root=Path(root)
    sources={s['id']:s for s in data['sources']}
    products={p['id']:p for p in data['products']}
    def put(path, text):
        write_private(root/path, text.encode())
    put('schema.md', SCHEMA)
    put('AGENTS.md', '# 医学 Wiki 维护规则\n\n遵守 schema.md 的三层结构、业务边界、审批与维护流程。原件不可改写，日志只追加；私人练习不得写入共享知识。\n')
    put('purpose.md', '# 医学沟通训练知识库\n\n为本品与竞品学术沟通提供可追溯资料；自动整理不等于医学审核，不用于患者诊疗。\n')
    for sid,s in sources.items():
        body=f'# {s["title"]}\n\n来源：{s["url"]}\n\n地区：{s.get("jurisdiction", "未确认")}；修订/发表：{s.get("published_at") or "未确认"}；抓取：{s["retrieved_at"]}\n\n质量：{s["quality"]}；自动归档，待医学审核。\n\n适用边界：{s.get("scope_note", "以原文、地区与版本为准。")}\n\n## 关联产品\n\n'
        body+='\n'.join(f'- [[entities/{pid}|{products[pid]["name"]}]]' for pid in s['product_ids'] if pid in products)
        body+='\n\n'+'\n\n'.join(f'## 原文第 {p["number"]} 页 / 段\n\n{p["text"]}' for p in s['pages'])
        put(f'wiki/sources/{sid}.md',markdown({'type':'source','title':s['title'],'sources':[s['original_path']], 'sha256':s['sha256'],'jurisdiction':s.get('jurisdiction'),'review_status':'pending'},body))
    comparisons=[]
    for pid,p in products.items():
        related=[s for s in sources.values() if pid in s['product_ids']]
        body=f'# {p["brand"]} / {p["name"]}\n\n'+('竞品资料' if p.get('ownership')=='competitor' else '本公司产品目录')+'；自动整理，待医学审核。\n\n## 来源\n\n'
        body+='\n'.join(f'- [[sources/{s["id"]}|{s["title"]}]]' for s in related)
        links=[c for c in products.values() if pid in c.get('compares_with',[]) or c['id']==pid and c.get('compares_with')]
        if links:
            body+='\n\n## 比较参考\n\n'+'\n'.join(f'- [[comparisons/{c["id"]}|{c["brand"]} 比较边界]]' for c in links)
        result=data.get('compiled',{}).get(pid,{})
        body+='\n\n## 尚待补齐与冲突\n\n'+'\n'.join('- '+g for g in [*p.get('gaps',[]),*result.get('gaps',[])])
        body+='\n\n## 编译的医学要点\n\n自动整理，待医学复核；判断时必须返回引用原文。\n\n'
        body+='\n\n'.join(f'- {f["claim"]}\n  - [[sources/{f["source_id"]}]] 第 {f["page"]} 页；SHA-256：{f["sha256"]}；原文：{f["quote"]}' for f in result.get('facts',[]))
        put(f'wiki/entities/{pid}.md',markdown({'type':'entity','title':p['name'],'review_status':'pending','sources':[s['id'] for s in related]},body))
        if p.get('compares_with'):
            body=f'# {p["brand"]} 比较参考\n\n{p["relationship"]}。仅建立资料关系，未形成医学比较结论。\n\n'
            body+='\n'.join(f'- [[entities/{i}|{products[i]["name"]}]]' for i in [pid,*p['compares_with']] if i in products)
            body+='\n\n## 核对清单\n\n分别核对地区、制剂、适应症、人群、线次、联合方案、终点、随访与修订版本。\n\n## 缺口与冲突\n\n资料只支持标注地区、制剂与版本范围内的内容；国外批准不能推断国内适应症。关联不代表可替换或优效，跨试验数值不能直接比较。缺口见实体页。\n'
            put(f'wiki/comparisons/{pid}.md',markdown({'type':'comparison','review_status':'pending'},body))
            comparisons.append(f'- [[comparisons/{pid}|{p["brand"]} 比较边界]]')
    index='# 医学 Wiki 索引\n\n## 本公司产品\n\n'
    index+='\n'.join(f'- [[entities/{p["id"]}|{p["brand"]} / {p["name"]}]] — {len(p["sources"])} 份来源' for p in products.values() if p.get('ownership')!='competitor')
    index+='\n\n## 竞品资料\n\n'+'\n'.join(f'- [[entities/{p["id"]}|{p["brand"]}]] — {p.get("jurisdiction", "未确认")}；待审核' for p in products.values() if p.get('ownership')=='competitor')
    index+='\n\n## 比较主题\n\n'+'\n'.join(comparisons)
    index+='\n\n## 来源\n\n'+'\n'.join(f'- [[sources/{s["id"]}|{s["title"]}]] — {s.get("jurisdiction", "未确认")} / {s["kind"]}' for s in sources.values())
    pack=data.get('demo_pack')
    if pack:
        body=f'# {pack["title"]}\n\n{pack["scope"]}\n\n核查日期：{pack["checked_at"]}；自动归档，待医学审核。\n\n## 产品\n\n'
        body+='\n'.join(f'- [[entities/{pid}|{products[pid]["brand"]}]]' for pid in pack['product_ids'] if pid in products)
        body+='\n\n## 医生公开背景与训练设定\n\n'
        for doctor in pack.get('doctors',[]):
            sid=doctor['source_id']
            if sid not in sources:
                continue
            page=f'# {doctor["name"]}\n\nAI 模拟角色，非医生本人；不代表其观点、诊疗意见或产品推荐。\n\n## 公开背景\n\n{doctor["facts"]}\n\n[[sources/{sid}|公开来源原文]]\n\n## 独立训练设定\n\n{doctor["training_focus"]}\n\n[[demo|返回演示包]]\n'
            put(f'wiki/doctors/{doctor["id"]}.md',markdown({'type':'doctor','review_status':'pending','sources':[sid]},page))
            body+=f'- [[doctors/{doctor["id"]}|{doctor["name"]}]]\n'
        body+='\n## 政策与研究原文\n\n'
        body+='\n'.join(f'- [[sources/{sid}|{sources[sid]["title"]}]]' for sid in dict.fromkeys(pack['source_ids']+pack.get('existing_source_ids',[])) if sid in sources)
        body+='\n\n## 未取得正文\n\n'+'\n'.join(f'- {row["id"]}：{row["url"]}；不可用作已核验依据。' for row in pack.get('failures',[]))
        body+='\n\n## 演示验收\n\n- 肥胖与糖尿病分支分别核对适应症、剂量和人群。\n- 询问与诺和盈/穆峰达的差异时，返回具体来源，拒绝跨试验优效推断。\n- 询问医保时，区分目录、限定支付、调整申报和地方执行。\n- 未审核或正文缺失时明确缺口，不编造结论。\n- 医生公开履历与模拟追问设定分开，不暗示真实背书。\n'
        put('wiki/demo.md',markdown({'type':'demo','review_status':'pending'},body))
        index+='\n\n## 演示包\n\n- [[demo|玛仕度肽全国政策演示包]]\n'
    put('wiki/index.md',index.rstrip()+'\n')
    log=root/'wiki/log.md'
    put('wiki/log.md',(log.read_text() if log.exists() else '# 维护日志\n')+f'\n## [{datetime.now(timezone.utc).isoformat()}] {operation} | 医学 Wiki\n\n{len(products)} 个实体、{len(sources)} 份来源、{len(comparisons)} 个比较主题。保留审批边界与来源版本。\n')


def lint_wiki(root):
    root=Path(root)/'wiki'
    pages={p.relative_to(root).with_suffix('').as_posix():p for p in root.rglob('*.md')}
    inbound=set(); errors=[]
    for name,path in pages.items():
        # Original documents can contain literal brackets: only lint our navigation before the raw body.
        body=path.read_text().split('## 原文第 ')[0]
        for target in re.findall(r'\[\[([^\]|]+)(?:\|[^\]]*)?\]\]',body):
            if target not in pages: errors.append(f'{name}: 断链 {target}')
            else: inbound.add(target)
    errors.extend(f'{name}: 孤立页' for name in pages if name not in inbound and name not in ('index','log'))
    return errors
