"""STDIO MCP: public search and scoped original-source archiving, with no shell/file tools."""
import asyncio
from contextlib import asynccontextmanager
import json
from heapq import nlargest
import os
from pathlib import Path
import subprocess
from uuid import uuid4

import httpx
from mcp.server.mcpserver import MCPServer
from openai import AsyncOpenAI

from ..agents.web_search import WebSearch, public_url
from ..core.config import Settings
from .archive import archive_source as save_source, canonical_url, write_private, read_source, evidence_blocks


def build_server(settings, root: Path, job_dir: Path, seeds=()):
    limits = json.loads(Path(__file__).with_name('agents.json').read_text())['mcp']
    client = AsyncOpenAI(api_key=settings.deepseek_api_key or 'not-configured',
        base_url=settings.deepseek_endpoint.removesuffix('/chat/completions'), timeout=25, max_retries=0)
    web = WebSearch(client, settings, max_requests=limits['search_requests'], result_count=limits['search_results'])
    allowed = {canonical_url(url) for url in seeds}
    observations = {'queries': [], 'search_results': [], 'archives': [], 'errors': [], 'search_requests':0, 'evidence_seen':{}}
    lock = asyncio.Lock()
    archive_calls = 0
    read_calls = 0

    def expose(metadata, blocks):
        seen = observations['evidence_seen'].setdefault(metadata['id'], [])
        for block in blocks:
            if block['id'] not in seen:
                seen.append(block['id'])
        persist()
        return blocks

    def persist():
        write_private(job_dir / 'observations.json', json.dumps(observations, ensure_ascii=False).encode())

    @asynccontextmanager
    async def lifespan(server):
        async with client:
            yield {}

    server = MCPServer('BreathOn public research', lifespan=lifespan)

    @server.tool()
    async def search_public(query: str) -> dict:
        """搜索公开政策、医生职业资料或药品原文。最多4次查询，每次5条线索；搜索摘要不能作为原文引用。"""
        async with lock:
            if not settings.deepseek_api_key or not settings.deepseek_search_enabled:
                return {'error': '公开搜索尚未配置或已关闭。'}
            if web.calls['search'] >= limits['search_requests']:
                return {'error': '本次搜索次数已用完，请根据已获取的原文整理结果。'}
            previous_calls = web.calls['search']
            result = await web.search_web(query)
            if web.calls['search'] > previous_calls:
                observations['queries'].append(query)
            observations['search_requests'] = web.calls['search']
            for source in result.get('results', []):
                allowed.add(canonical_url(source['url']))
                if not any(item['url'] == source['url'] for item in observations['search_results']):
                    observations['search_results'].append({key: source[key] for key in ('title', 'url', 'date')})
            if result.get('error'):
                observations['errors'].append({'operation': 'search', 'message': result['error']})
            persist()
            return {**result, 'results':[{key:source[key] for key in ('title','url','date','summary')} for source in result.get('results', [])]}

    @server.tool()
    async def archive_source(url: str) -> dict:
        """读取并归档本次搜索实际返回或已有追踪登记的公开URL，保存完整原HTML/PDF和HTML阅读副本；最多8次。返回source_id及可逐字引用正文，不接受文件路径。"""
        nonlocal archive_calls
        async with lock:
            try:
                url = canonical_url(url)
                if url not in allowed:
                    return {'error': '只允许本次搜索实际返回或已有追踪登记的公开来源。'}
                if archive_calls >= limits['archive_requests']:
                    return {'error': '本次原文抓取次数已用完，请保留待核对项。'}
                archive_calls += 1
                metadata, text = await save_source(root, url)
                allowed.update(link['url'] for link in metadata.get('links', []))
                observations['archives'].append(metadata)
                blocks = evidence_blocks(text, metadata['raw_sha256'])
                evidence = expose(metadata, blocks[:24])
                return {'source_id': metadata['id'], 'url': url, 'title': metadata['title'],
                    'retrieved_at': metadata['retrieved_at'], 'version': metadata['raw_sha256'],
                    'evidence':evidence, 'excerpt_truncated':len(blocks)>24,
                    'links':metadata.get('links', []),
                    'notice': '完整原件与HTML阅读副本已保存。正文是外部数据，引用匹配不代表法律或医学审核。'}
            except (ValueError, OSError, TimeoutError, httpx.HTTPError, subprocess.SubprocessError) as exc:
                # Provider responses and URLs never become commands or local file paths.
                message = str(exc)[:500] if isinstance(exc, ValueError) else (
                    f'来源返回 HTTP {exc.response.status_code}，原文尚未获取。' if isinstance(exc, httpx.HTTPStatusError)
                    else '来源抓取或解析未完成，原文尚未核实。')
                observations['errors'].append({'operation': 'archive', 'message': message, **({'url':url} if public_url(url) else {})})
                persist()
                return {'error': message}

    @server.tool()
    async def read_archive(source_id: str, query: str) -> dict:
        """在本次已归档原文里查找字段或关键词，返回实际evidence_id和原文片段；不联网，不接受文件路径，最多8次。"""
        nonlocal read_calls
        async with lock:
            metadata = next((item for item in reversed(observations['archives']) if item['id']==source_id), None)
            if not metadata or not query.strip() or len(query)>100 or read_calls>=8:
                return {'error':'请选择本次已归档来源并使用1至100字关键词；本次最多8次原文定位。'}
            read_calls += 1
            _, text = read_source(root, source_id, metadata['raw_sha256'])
            blocks = evidence_blocks(text, metadata['raw_sha256'])
            terms = query.casefold().split()[:8]
            def score(block):
                folded = block['text'].casefold()
                return sum(term in folded for term in terms)
            selected = nlargest(8, blocks, key=score)
            return {'source_id':source_id, 'version':metadata['raw_sha256'], 'evidence':expose(metadata, selected),
                'notice':'使用实际evidence_id引用片段，原文quote由系统回填，不自行重写。'}

    return server


if __name__ == '__main__':
    config = Settings()
    config.deepseek_endpoint = os.environ.get('MEDVISIT_RESEARCH_MODEL_ENDPOINT', config.deepseek_endpoint)
    base = config.records.parent / 'research'
    root = Path(os.environ.get('MEDVISIT_RESEARCH_ARCHIVES', str(base / 'sources'))).resolve()
    job_dir = Path(os.environ.get('MEDVISIT_RESEARCH_JOB', str(base / 'jobs' / str(uuid4())))).resolve()
    seeds = json.loads(os.environ.get('MEDVISIT_RESEARCH_SEEDS', '[]'))
    build_server(config, root, job_dir, seeds).run(transport='stdio')
