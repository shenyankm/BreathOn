"""Import the source-bound mazdutide demo pack; never approve it automatically."""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ingest_medical import parse_pdf
from medvisit.research.archive import download_public, decode_html, PageText
from medvisit.storage.records import write_private
from medvisit.knowledge.corpus import compact
from medvisit.knowledge.wiki import render_wiki

MANIFEST=Path(__file__).resolve().parents[1]/'medvisit/knowledge/mazdutide_demo.json'

async def ingest(root, refresh=False):
    root=Path(root); data=json.loads((root/'corpus.json').read_text())
    manifest=json.loads(MANIFEST.read_text())
    sources={s['id']:s for s in data['sources']}
    products={p['id']:p for p in data['products']}
    failures=[];slots=asyncio.Semaphore(3)
    async def fetch(row):
        sid=row['id'];previous=sources.get(sid)
        if previous and not refresh and previous['url']==row['url']:
            path=root/previous['original_path']
            if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest()==previous['sha256']:
                sources[sid]={**previous, **{k:v for k,v in row.items() if k!='required_terms'}}
                print(sid,'cached',flush=True);return
        async with slots:
            try:
                raw,url,headers=await download_public(row['url'],max_bytes=40_000_000)
                suffix='pdf' if raw.startswith(b'%PDF-') else 'html'
                sha=hashlib.sha256(raw).hexdigest();relative=f'raw/sources/{sid}/{sha}.{suffix}'
                write_private(root/relative,raw)
                if suffix=='pdf': pages=await asyncio.to_thread(parse_pdf,raw)
                else:
                    parser=PageText();parser.feed(decode_html(raw,headers.get('content-type','')))
                    pages=[{'number':1,'text':parser.text}]
                text=compact('\n'.join(p['text'] for p in pages))
                if len(text)<100 or any(compact(term) not in text for term in row.get('required_terms',[])):
                    raise ValueError('正文缺失或与目标资料不匹配')
                source={k:v for k,v in row.items() if k!='required_terms'}
                source.update(url=url,sha256=sha,original_path=relative,pages=pages,trials=row.get('trials',[]),
                              retrieved_at=datetime.now(timezone.utc).isoformat(),review_status='pending',pack_id=manifest['id'])
                for version in (previous,source):
                    if version:
                        path=root/'versions'/sid/f'{version["sha256"]}.json'
                        if not path.exists(): write_private(path,json.dumps(version,ensure_ascii=False).encode())
                sources[sid]=source
                print(sid,len(pages),'pages',flush=True)
            except Exception as exc:
                failures.append({'id':sid,'url':row['url'],'reason':str(exc)[:200],'previous_retained':previous is not None})
                print(sid,'UNAVAILABLE',type(exc).__name__,flush=True)
    await asyncio.gather(*(fetch(row) for row in manifest['sources']))
    for product in manifest['products']:
        products[product['id']]={**product,'sources':[s['id'] for s in sources.values() if product['id'] in s['product_ids']]}
    for p in products.values():
        p['sources']=[s['id'] for s in sources.values() if p['id'] in s['product_ids']]
    # Only affected products lose compilation; unchanged sources retain previous work.
    previous_sources={s['id']:s for s in data['sources']}
    for p in products.values():
        if any(previous_sources.get(sid)!=sources[sid] for sid in p['sources']):
            data.get('compiled',{}).pop(p['id'],None)
    data.update(products=list(products.values()),sources=list(sources.values()),built_at=datetime.now(timezone.utc).isoformat())
    data['demo_pack']={k:v for k,v in manifest.items() if k not in ('products','sources')}
    data['demo_pack'].update(source_ids=[s['id'] for s in manifest['sources']],product_ids=['mazdutide',*[p['id'] for p in manifest['products']]],failures=failures)
    write_private(root/'corpus.json',json.dumps(data,ensure_ascii=False).encode())
    render_wiki(root,data,'ingest')
    print(json.dumps({'sources':len(sources),'products':len(products),'failed':len(failures)},ensure_ascii=False),flush=True)
    return data

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--refresh',action='store_true')
    args=parser.parse_args()
    asyncio.run(ingest(args.root,args.refresh))
