"""Opt-in real model + STDIO MCP + original HTML/PDF acceptance, isolated from app history."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from time import monotonic

from medvisit.core.config import Settings
from medvisit.platform.store import PlatformStore, now
from medvisit.research.models import ResearchRequest
from medvisit.research.service import ResearchService


async def run(output, only_kind=None):
    settings = Settings(records=output/'sessions')
    if not settings.deepseek_api_key or not settings.deepseek_search_enabled:
        raise SystemExit('请配置 DeepSeek 并开启搜索；没有执行真实调用。')
    store = PlatformStore(output/'research.sqlite3')
    store.open()
    service = ResearchService(store, settings, lambda: {'workspace':'research-acceptance'})
    report = {'started_at':now(), 'mocked_services':False, 'medical_or_legal_review':False, 'agents':[]}
    queries = {'doctor':'复旦大学附属中山医院 李小英 内分泌科 官方医生资料',
        'drug':'玛仕度肽 中国 成人体重管理 同类药品 获批说明书'}
    if only_kind:
        queries = {only_kind:queries[only_kind]}
    try:
        for kind, query in queries.items():
            started = monotonic()
            job = await service.start(ResearchRequest(kind=kind, query=query))
            await asyncio.gather(*list(service.tasks), return_exceptions=True)
            finished = service.get_job(job['id'])
            sources = [source for source in service.list('research_source') if source['id'] in finished['source_ids']]
            for source in sources:
                version = next(change['version'] for change in finished['changes'] if change['source_id'] == source['id'])
                folder = service.archives/source['id']/version
                metadata = json.loads((folder/'metadata.json').read_text())
                assert hashlib.sha256((folder/metadata['original_file']).read_bytes()).hexdigest() == version
                assert (folder/'reader.html').read_bytes().startswith(b'<!doctype html>')
            item = {'kind':kind, 'job_id':job['id'], 'status':finished['status'], 'error':finished['error'],
                'elapsed_seconds':round(monotonic()-started, 3), 'archives':len(sources),
                'findings':len((finished.get('result') or {}).get('findings', [])), 'usage':finished['usage'],
                'source_urls':[source['url'] for source in sources], 'source_errors':finished.get('source_errors', [])}
            item['functional_pass'] = bool(item['archives'] and item['findings'])
            report['agents'].append(item)
            output.mkdir(parents=True, exist_ok=True)
            (output/'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({key:item[key] for key in ('kind','status','archives','findings','functional_pass')}, ensure_ascii=False), flush=True)
    finally:
        await service.close()
    report['finished_at'] = now()
    report['passed'] = all(item['functional_pass'] for item in report['agents']) and len(report['agents']) == len(queries)
    (output/'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='确认执行真实模型与搜索调用，会产生用量。')
    parser.add_argument('--output', type=Path, default=Path('data/validation/research-live'))
    parser.add_argument('--kind', choices=['doctor','drug'], help='只复验指定助手，避免重复真实调用。')
    args = parser.parse_args()
    if not args.live:
        parser.error('真实验收需要显式 --live；没有执行调用。')
    raise SystemExit(0 if asyncio.run(run(args.output.resolve(), args.kind)) else 1)
