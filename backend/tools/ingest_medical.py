"""Compile public originals into a Karpathy LLM Wiki project.

Run: uv run --directory backend python tools/ingest_medical.py --compile-wiki
No generated summary is promoted to original medical evidence.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from medvisit.research.archive import download_public, PageText, decode_html
from medvisit.storage.records import write_private

PRODUCTS = Path(__file__).resolve().parents[1]/'medvisit/knowledge/products.json'
TRIALS = {
    'sintilimab':['ORIENT-11','ORIENT-15','ORIENT-16','ORIENT-32'],
    'bevacizumab':['IBI305 phase 3'], 'adalimumab':['IBI303 phase 3'], 'rituximab':['IBI301 phase 3'],
    'pemigatinib':['FIGHT-202'], 'olverembatinib':['olverembatinib chronic myeloid phase'],
    'ramucirumab':['RAINBOW ramucirumab','REVEL ramucirumab','REACH-2'],
    'selpercatinib':['LIBRETTO-001','LIBRETTO-431'], 'equecabtagene':['FUMANBA-1'],
    'tafolecimab':['CREDIT-1 tafolecimab','CREDIT-2 tafolecimab','CREDIT-4 tafolecimab'],
    'fulzerasib':['fulzerasib phase 2'], 'pirtobrutinib':['BRUIN pirtobrutinib mantle'],
    'taletrectinib':['TRUST-I taletrectinib','TRUST-II taletrectinib'],
    'limertinib':['limertinib phase 3'], 'teprotumumab':['IBI311 thyroid eye disease'],
    'mazdutide':['GLORY-1','DREAMS-1 mazdutide','DREAMS-2 mazdutide'],
    'picankibart':['CLEAR-1 picankibart'], 'ipilimumab':['sintilimab ipilimumab neoadjuvant mismatch repair'],
    'abemaciclib':['MONARCH 3 abemaciclib'], 'quizartinib':['QuANTUM-First'],
}
POLICIES = [
    ('nrdl-2025-notice','policy','2025 年国家医保及商保目录实施通知',
     'https://www.nhsa.gov.cn/art/2025/12/7/art_104_18970.html','2025-12-07'),
    ('nrdl-2025','reimbursement','国家基本医疗保险、生育保险和工伤保险药品目录（2025年）',
     'https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a32f9f2f3fc046afaf08471f87456ce3.pdf','2025-12-07'),
    ('commercial-2025','reimbursement','商业健康保险创新药品目录（2025年）',
     'https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=da298734646c4a4ca1b5ca612ee23fb1.pdf','2025-12-07'),
]
GUIDELINES = [
    ('esmo-ebc-2024',['abemaciclib'],'Pan-Asian ESMO 早期乳腺癌指南（2024）',
     'https://pmc.ncbi.nlm.nih.gov/articles/PMC11145753/','2024','Asia'),
    ('eln-aml-2022',['quizartinib'],'ELN 成人 AML 诊疗建议（2022，早于 QuANTUM-First 正式发表）',
     'https://ddd.uab.cat/pub/artpub/2022/280875/280875.pdf','2022','International'),
]


def parse_pdf(raw):
    result = subprocess.run([sys.executable, __file__, '--extract-pdf'],input=raw,capture_output=True,
        timeout=70,env={'PATH':os.defpath},cwd='/tmp')
    if result.returncode or len(result.stdout)>8_000_000:
        raise ValueError('PDF extraction exceeded limits')
    return json.loads(result.stdout)


def markdown(frontmatter, body):
    # JSON scalar/list literals are also valid YAML; no new YAML dependency.
    return '---\n'+'\n'.join(f'{key}: {json.dumps(value,ensure_ascii=False)}' for key,value in frontmatter.items())+'\n---\n\n'+'\n'.join(line.rstrip() for line in body.splitlines()).rstrip()+'\n'


async def compile_wiki(root, refresh=False, ocr_command=None):
    root=Path(root)
    products=json.loads(PRODUCTS.read_text())
    previous={}
    if (root/'corpus.json').exists():
        previous={s['id']:s for s in json.loads((root/'corpus.json').read_text())['sources']}
        for source in previous.values():
            history=root/'versions'/source['id']/f'{source["sha256"]}.json'
            if not history.exists(): write_private(history,json.dumps(source,ensure_ascii=False).encode())
    sources,errors=[],[]
    checked=datetime.now(timezone.utc).isoformat()
    slots=asyncio.Semaphore(3)

    async def ingest(source_id, kind, title, url, ids, *, published_at=None, jurisdiction='CN', quality='original', trials=()):
        if not refresh and source_id in previous:
            sources.append(previous[source_id]);return
        async with slots:
            try:
                cached=sorted((root/'raw/sources'/source_id).glob('*'),key=lambda p:p.stat().st_mtime,reverse=True)
                cached=next((p for p in cached if p.suffix in ('.pdf','.jpg')),None)
                retrieved_at=checked
                if cached is not None and not refresh:
                    raw=cached.read_bytes()
                    if hashlib.sha256(raw).hexdigest()!=cached.stem: raise ValueError('归档原件校验失败')
                    resolved,headers=url,{}
                    retrieved_at=datetime.fromtimestamp(cached.stat().st_mtime,timezone.utc).isoformat()
                else:
                    raw,resolved,headers=await download_public(url,max_bytes=100_000_000)
                sha=hashlib.sha256(raw).hexdigest()
                suffix='pdf' if raw.startswith(b'%PDF-') else 'jpg' if raw.startswith(b'\xff\xd8') else 'html'
                relative=f'raw/sources/{source_id}/{sha}.{suffix}'
                write_private(root/relative,raw)
                if raw.startswith(b'%PDF-'):
                    try:
                        pages=await asyncio.to_thread(parse_pdf,raw)
                    except (ValueError,subprocess.TimeoutExpired):
                        if not ocr_command: raise
                        result=await asyncio.to_thread(subprocess.run,[ocr_command,str(root/relative)],capture_output=True,timeout=240)
                        if result.returncode: raise ValueError('OCR 未完成，原件已保留')
                        pages=json.loads(result.stdout)
                        quality='ocr' if quality=='original' else quality
                    suffix='pdf'
                elif suffix=='jpg' and ocr_command:
                    result=await asyncio.to_thread(subprocess.run,[ocr_command,str(root/relative)],capture_output=True,timeout=240)
                    if result.returncode: raise ValueError('OCR 未完成，原件已保留')
                    pages=json.loads(result.stdout);quality='ocr'
                else:
                    if 'html' not in headers.get('content-type',''):
                        raise ValueError('原文为图片或未知格式，需 OCR 并人工核实')
                    parser=PageText();parser.feed(decode_html(raw,headers.get('content-type','')))
                    if len(parser.text.strip())<100 or 'Checking your browser' in parser.text[:500]:
                        raise ValueError('原文正文不可读取，不能用访问验证页面代替')
                    pages=[{'number':1,'text':parser.text}];suffix='html'
                sources.append({'id':source_id,'title':title,'url':resolved,'kind':kind,'product_ids':ids,
                    'sha256':sha,'retrieved_at':retrieved_at,'published_at':published_at,'jurisdiction':jurisdiction,
                    'quality':quality,'trials':list(trials),'original_path':relative,'pages':pages})
                print('Imported',source_id, len(pages),'pages',flush=True)
            except Exception as exc:
                errors.append({'id':source_id,'url':url,'product_ids':ids,'kind':kind,'error':str(exc)[:250] or type(exc).__name__})
                print('Needs attention',source_id,str(exc)[:150],flush=True)

    jobs=[]
    for product in products:
        pid=product['id']
        product['aliases']=[re.sub(r'注射液|胶囊|片|己二酸|盐酸','',product['name']), *TRIALS[pid]]
        quality='patient_guide' if '非说明书' in product['document_label'] else 'version_uncertain' if pid=='mazdutide' else 'original'
        jobs.append(ingest('label-'+pid,'patient_guide' if quality=='patient_guide' else 'label',
            product['name']+' '+product['document_label'],product['url'],[pid],quality=quality))
    for sid,kind,title,url,date in POLICIES:
        jobs.append(ingest(sid,kind,title,url,[p['id'] for p in products],published_at=date))
    for sid,ids,title,url,date,region in GUIDELINES:
        jobs.append(ingest(sid,'guideline',title,url,ids,published_at=date,jurisdiction=region))
    await asyncio.gather(*jobs)

    # NCBI allows three unauthenticated requests/sec; sequential requests also give reproducible manifests.
    pmids={'38194616':(['abemaciclib'],['monarchE 5-year']), '41110697':(['abemaciclib'],['monarchE overall survival']),
        '37116523':(['quizartinib'],['QuANTUM-First'])}
    for pid,queries in TRIALS.items():
        for query in queries:
            if pid=='quizartinib': continue
            try:
                cache=root/'discovery'/f'{hashlib.sha256(query.encode()).hexdigest()}.json'
                if cache.exists() and not refresh:
                    payload=json.loads(cache.read_text())
                else:
                    raw,_,_=await download_public('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?'+urlencode({
                        'db':'pubmed','term':query+' NOT review[Publication Type]','retmode':'json','retmax':1,'sort':'relevance'}))
                    payload=json.loads(raw);write_private(cache,raw);await asyncio.sleep(.4)
                found=payload['esearchresult']['idlist']
                if not found: raise ValueError('未找到对应研究原文记录')
                for pmid in found:
                    ids,trials=pmids.setdefault(pmid,([],[]))
                    if pid not in ids: ids.append(pid)
                    if query not in trials: trials.append(query)
            except Exception as exc:
                errors.append({'id':'trial-'+pid,'product_ids':[pid],'kind':'trial','error':query+': '+str(exc)[:120]})
    for pmid,(ids,trials) in pmids.items():
        sid='pubmed-'+pmid
        if not refresh and sid in previous:
            sources.append(previous[sid]);continue
        try:
            raw,_,_=await download_public('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?'+urlencode({'db':'pubmed','id':pmid,'retmode':'xml'}))
            article=ET.fromstring(raw).find('.//PubmedArticle')
            title=''.join(article.find('.//ArticleTitle').itertext())
            abstracts=article.findall('.//Abstract/AbstractText')
            if not abstracts: raise ValueError('该记录未提供可核对的摘要')
            body='\n'.join((part.get('Label','')+'\n'+''.join(part.itertext())).strip() for part in abstracts)
            date=article.find('.//JournalIssue/PubDate')
            date='-'.join(date.itertext()) if date is not None else None
            sha=hashlib.sha256(raw).hexdigest();relative=f'raw/sources/{sid}/{sha}.xml'
            write_private(root/relative,raw)
            sources.append({'id':sid,'title':title,'url':f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/','kind':'trial',
                'product_ids':ids,'sha256':sha,'retrieved_at':checked,'published_at':date,'jurisdiction':'Study population',
                'quality':'abstract','trials':trials,'original_path':relative,'pages':[{'number':1,'text':title+'\n'+body}]})
            print('Imported',sid,title[:65],flush=True)
            await asyncio.sleep(.4)
        except Exception as exc:
            errors.append({'id':sid,'product_ids':ids,'kind':'trial','error':str(exc)[:250]})

    sources.sort(key=lambda s:s['id'])
    for source in sources:
        history=root/'versions'/source['id']/f'{source["sha256"]}.json'
        if not history.exists(): write_private(history,json.dumps(source,ensure_ascii=False).encode())
    for product in products:
        related=[s for s in sources if product['id'] in s['product_ids']]
        product['sources']=[s['id'] for s in related]
        product['gaps']=[]
        for kind,label in [('label','法定说明书'),('trial','临床研究'),('guideline','指南原文')]:
            if not any(s['kind']==kind for s in related): product['gaps'].append('尚缺可读取的'+label)
        if product['id']=='mazdutide': product['gaps'].append('官网说明书修订日期含占位文本，版本待核实')
        if any(s['quality']=='ocr' for s in related): product['gaps'].append('图片说明书已 OCR，识别文字和数值须人工医学核对')
        product['gaps'].extend(error['error'] for error in errors if product['id'] in error['product_ids'] and error['kind']=='label')
    data={'format':1,'built_at':checked,'products':products,'sources':sources,'errors':errors,
        'catalogue_source':'https://www.innoventbio.com/#/product/products',
        'catalogue_checked_at':'2026-10-29','review_status':'automated_import_pending_medical_review'}
    write_private(root/'corpus.json',json.dumps(data,ensure_ascii=False).encode())
    write_private(root/'purpose.md','# BreathOn 医学依据\n\n用于医药代表训练的逐句自动核验；未经人工医学审核，不用于患者诊疗。\n'.encode())
    write_private(root/'schema.md','# 知识规则\n\nwiki/entities 为产品，wiki/sources 为来源阅读副本。sources 指向不可变 raw/sources 原件。说明书、临床研究、指南和医保分别保留；不能相互替代。\n'.encode())
    for source in sources:
        body=f'# {source["title"]}\n\n来源：{source["url"]}\n\n抓取：{source["retrieved_at"]}；版本：{source.get("published_at") or "未确认"}；文档范围：{source["quality"]}\n\n自动归档，待医学审核。\n\n'
        body+='\n\n'.join(f'## 原文第 {page["number"]} 页 / 段\n\n{page["text"]}' for page in source['pages'])
        write_private(root/'wiki/sources'/f'{source["id"]}.md',markdown({'type':'source','title':source['title'],
            'sources':[source['original_path']],'sha256':source['sha256'],'review_status':'pending'},body).encode())
    for product in products:
        related=[s for s in sources if product['id'] in s['product_ids']]
        body=f'# {product["brand"]} / {product["name"]}\n\n'+'\n'.join(f'- [[sources/{s["id"]}|{s["title"]}]]' for s in related)
        body+='\n\n## 尚待补齐\n\n'+'\n'.join('- '+gap for gap in product['gaps'])
        write_private(root/'wiki/entities'/f'{product["id"]}.md',markdown({'type':'entity','title':product['name'],
            'sources':[s['original_path'] for s in related]},body).encode())
    write_private(root/'wiki/index.md',('# BreathOn 医学依据\n\n'+'\n'.join(f'- [[entities/{p["id"]}|{p["brand"]} / {p["name"]}]]' for p in products)).encode())
    log=root/'wiki/log.md'
    previous_log=log.read_text() if log.exists() else '# 导入日志\n'
    write_private(log,(previous_log+f'\n## [{checked}] ingest | 官方产品与依据\n\n{len(products)} 个产品、{len(sources)} 份可读取原文、{len(errors)} 项待处理。未经人工医学审核。\n').encode())
    print(json.dumps({'products':len(products),'sources':len(sources),'errors':len(errors),'root':str(root)},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]/'data/sessions/medical-wiki')
    parser.add_argument('--refresh',action='store_true')
    parser.add_argument('--compile-wiki',action='store_true',help='Compile source-bound product pages using the configured model')
    parser.add_argument('--ocr-command',help='Optional local macOS Vision OCR executable; never downloads an app')
    parser.add_argument('--extract-pdf',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.extract_pdf:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU,(55,55))
        from pypdf import PdfReader,apply_configuration
        raw=sys.stdin.buffer.read(100_000_001)
        if len(raw)>100_000_000: raise ValueError('PDF is too large')
        with apply_configuration(maximum_declared_stream_length=32_000_000,zlib_maximum_output_length=64_000_000):
            reader=PdfReader(BytesIO(raw),strict=False)
            if reader.is_encrypted or not 1<=len(reader.pages)<=500: raise ValueError('PDF page limit')
            pages=[]
            for number,page in enumerate(reader.pages,1):
                text=page.extract_text() or ''
                if len(text)>50000: raise ValueError('PDF page text limit')
                if text.strip(): pages.append({'number':number,'text':text})
            if sum(len(p['text']) for p in pages)>2_000_000 or not pages: raise ValueError('PDF text limit')
            print(json.dumps(pages,ensure_ascii=False))
    else:
        async def run():
            await compile_wiki(args.root,args.refresh,args.ocr_command)
            if args.compile_wiki:
                from medvisit.core.config import Settings
                from medvisit.knowledge.compile import compile_products
                await compile_products(Settings(),args.root)
        asyncio.run(run())
