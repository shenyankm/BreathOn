"""Incrementally archive official competitor labels without replacing existing evidence."""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest_medical import parse_pdf
from medvisit.research.archive import download_public
from medvisit.storage.records import write_private
from medvisit.knowledge.wiki import render_wiki

MANIFEST=Path(__file__).resolve().parents[1]/'medvisit/knowledge/competitors.json'

async def ingest(root):
    root=Path(root)
    data=json.loads((root/'corpus.json').read_text())
    products={p['id']:p for p in data['products']};sources={s['id']:s for s in data['sources']}
    for product in json.loads(MANIFEST.read_text()):
        sid='label-'+product['id']
        raw,url,_=await download_public(product['url'],max_bytes=30_000_000)
        if not raw.startswith(b'%PDF-'): raise ValueError(f'{sid}: not a PDF')
        digest=hashlib.sha256(raw).hexdigest()
        relative=f'raw/sources/{sid}/{digest}.pdf'
        write_private(root/relative,raw)
        old=sources.get(sid)
        if old and old['sha256']==digest:
            print(sid,'unchanged');continue
        pages=await asyncio.to_thread(parse_pdf,raw)
        if product['brand'].casefold() not in pages[0]['text'].casefold(): raise ValueError(f'{sid}: wrong product')
        date=re.search(r'Revised:\s*(\d{1,2}/\d{4})','\n'.join(p['text'] for p in pages[:5]),re.I)
        revised=None
        if date:
            month,year=date[1].split('/');revised=f'{year}-{int(month):02d}'
        source={'id':sid,'title':product['brand']+' 美国处方说明书','url':url,'kind':'label',
                'product_ids':[product['id']],'sha256':digest,'retrieved_at':datetime.now(timezone.utc).isoformat(),
                'published_at':revised,'jurisdiction':'US','quality':'original' if revised else 'version_uncertain',
                'trials':[],'original_path':relative,'pages':pages,'review_status':'pending'}
        for version in [old,source]:
            if version:
                path=root/'versions'/sid/f'{version["sha256"]}.json'
                if not path.exists():write_private(path,json.dumps(version,ensure_ascii=False).encode())
        sources[sid]=source
        products[product['id']]={**product,'ownership':'competitor','sources':[sid],
            'gaps':['中国说明书未归档；美国说明书不能替代国内批准依据。','尚未完成人工医学审核。','直接比较研究尚未归档，不作优效或可替换性结论。']}
        data.get('compiled',{}).pop(product['id'],None)
        print(sid,len(pages),'pages',revised)
    data.update(products=list(products.values()),sources=list(sources.values()),
                built_at=datetime.now(timezone.utc).isoformat())
    write_private(root/'corpus.json',json.dumps(data,ensure_ascii=False).encode())
    render_wiki(root,data,'ingest')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--compile-wiki',action='store_true')
    args=parser.parse_args()
    async def run():
        await ingest(args.root)
        if args.compile_wiki:
            from medvisit.core.config import Settings
            from medvisit.knowledge.compile import compile_products
            await compile_products(Settings(),args.root,product_ids={p['id'] for p in json.loads(MANIFEST.read_text())})
    asyncio.run(run())
