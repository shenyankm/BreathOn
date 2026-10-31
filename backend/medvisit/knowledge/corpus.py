"""Source-bound medical evidence; generated wiki prose is never proof by itself."""
import hashlib
import json
from pathlib import Path
import re
from threading import Lock
from ..platform.models import content_usable


def compact(value):
    return re.sub(r'\s+', '', value).casefold()


def quotation_text(value):
    return re.sub(r'\s+', '', value)


def sentences(text):
    return [part.strip() for part in re.split(r'(?<=[。！？!?；;])\s*|\n+', text) if part.strip()]


def platform_approved_documents(store, current_user):
    def documents():
        workspace = current_user()['workspace']
        with store.transaction(workspace, write=False) as tx:
            return tx.list(workspace, 'content')
    return documents


class MedicalCorpus:
    def __init__(self, root, *, seed=None, approved_documents=None):
        self.root = Path(root)
        self.seed = Path(seed) if seed is not None else None
        self.approved_documents = approved_documents
        self._stamp = None
        self._data = None
        self._lock = Lock()

    def load(self):
        path = self.root / 'corpus.json'
        # A curated text snapshot is usable on a fresh checkout; immutable PDFs stay outside Git.
        if not path.exists() and self.seed is not None and (self.seed/'corpus.json').exists():
            path = self.seed/'corpus.json'
        with self._lock:
            try:
                stamp = (str(path),path.stat().st_mtime_ns)
                if self._data is None or stamp != self._stamp:
                    raw = path.read_bytes()
                    data = json.loads(raw)
                    if data.get('format') != 1 or not isinstance(data.get('sources'), list):
                        raise ValueError('Invalid medical corpus')
                    chunks = []
                    for source in data['sources']:
                        for page in source.get('pages', []):
                            body = page['text']
                            for offset in range(0, len(body), 1000):
                                excerpt = body[max(0, offset-200):offset+1200]
                                chunks.append({'id':f'{source["id"]}:p{page["number"]}:{offset}',
                                    'source_id':source['id'], 'page':page['number'], 'text':excerpt})
                    for product in data.get('products',[]):
                        aliases=list(product.get('aliases',[]))
                        for source in data['sources']:
                            if product['id'] not in source['product_ids']: continue
                            for trial in source.get('trials',[]):
                                aliases.extend(re.findall(r'\b(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+|monarchE|MONARCH\s*[23])\b',trial))
                        product['aliases']=list(dict.fromkeys(aliases))
                    data.update(version=hashlib.sha256(raw).hexdigest(), chunks=chunks)
                    self._data, self._stamp = data, stamp
                return self._data
            except (OSError, ValueError, KeyError, TypeError):
                # A broken replacement must not silently keep serving an older corpus as current.
                self._data, self._stamp = None, None
                return {'format':1, 'version':'unavailable', 'products':[], 'sources':[], 'chunks':[],
                    'built_at':None, 'error':'医学依据库尚未导入或暂不可读取。'}

    def status(self):
        data = self.load()
        return {key:data.get(key) for key in ('version', 'built_at', 'products', 'compiled', 'error')} | {
            'sources':[{key:value for key,value in source.items() if key not in ('pages', 'original_path')} | {
                'original_available':(self.root/source['original_path']).is_file()}
                for source in data['sources']],
            'integration':{'project':'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f', 'mode':'source_wiki' ,
                'note':'按 Karpathy LLM Wiki 方法管理原始资料、知识条目、索引和日志；不依赖桌面应用。'}}

    def reviewed_documents(self):
        if self.approved_documents is None:
            return []
        result = []
        for doc in self.approved_documents():
            try:
                valid = (content_usable(doc) and isinstance(doc['id'], str) and isinstance(doc['title'], str)
                         and isinstance(doc['version_label'], str) and type(doc['version']) is int
                         and isinstance(doc['pages'], list) and all(
                             isinstance(page, dict) and type(page.get('number')) is int
                             and isinstance(page.get('text'), str) for page in doc['pages']))
                if valid:
                    result.append(doc)
            except (TypeError, KeyError, ValueError):
                continue
        return result

    def approval_snapshot(self, data=None):
        data = self.load() if data is None else data
        if self.approved_documents is None:
            return {}
        approved = self.reviewed_documents()
        matches = {}
        receipts = []
        for doc in approved:
            receipt = {'document_id':doc['id'], 'document_version':doc['version'],
                       'version_label':doc['version_label'], 'document_sha256':hashlib.sha256(
                           json.dumps(doc.get('pages', []), ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
            receipts.append((doc, receipt))
            for page in doc.get('pages', []):
                matches[(f"platform-document-{doc['id']}", page['number'])] = receipt
        for source in data['sources']:
            for doc, receipt in receipts:
                if not doc.get('source_url') or source.get('url') != doc['source_url']:
                    continue
                pages = {p['number']: quotation_text(p['text']) for p in doc.get('pages', [])}
                for page in source.get('pages', []):
                    if pages.get(page['number']) == quotation_text(page['text']) and pages.get(page['number']):
                        key = (source['id'], page['number'])
                        if key not in matches or (receipt['document_id'], receipt['document_version']) < (matches[key]['document_id'], matches[key]['document_version']):
                            matches[key] = receipt
        return matches

    def approved_sources(self):
        if self.approved_documents is None:
            return []
        result = []
        for doc in self.reviewed_documents():
            pages = doc.get('pages', [])
            digest = hashlib.sha256(json.dumps(pages, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            result.append({'id':f"platform-document-{doc['id']}", 'title':doc['title'],
                'url':doc.get('source_url', ''), 'sha256':digest, 'published_at':doc.get('publication_date'),
                'retrieved_at':doc.get('approved_at') or '', 'kind':'reviewed_content', 'quality':'original',
                'jurisdiction':doc.get('scope',''), 'product_ids':[], 'trials':[], 'pages':pages,
                'original_path':'', 'document_id':doc['id'], 'document_version':doc['version']})
        return result

    def search(self, text, context='', limit=12, *, data=None, approvals=None):
        data = self.load() if data is None else data
        approvals = self.approval_snapshot(data) if approvals is None else approvals
        derived = self.approved_sources()
        sources_data = [*data['sources'], *derived]
        derived_chunks = []
        for source in derived:
            for page in source['pages']:
                for offset in range(0, len(page['text']), 1000):
                    derived_chunks.append({'id':f"{source['id']}:p{page['number']}:{offset}",
                        'source_id':source['id'], 'page':page['number'],
                        'text':page['text'][max(0, offset-200):offset+1200]})
        query, background = compact(text), compact(context)
        explicit = [p['id'] for p in data['products'] if any(compact(alias) in query for alias in
            (p['id'], p['name'], p['brand'], *p.get('aliases', [])) if alias)]
        products = explicit or [p['id'] for p in data['products'] if any(compact(alias) in background for alias in
            (p['id'], p['name'], p['brand'], *p.get('aliases', [])) if alias)]
        tokens = set(re.findall(r'[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?', query))
        tokens.update(query[i:i+2] for i in range(len(query)-1) if all('\u4e00' <= c <= '\u9fff' for c in query[i:i+2]))
        sources = {source['id']:source for source in sources_data}
        ranked = []
        compiled_sources = set()
        for pid in products:
            for fact in data.get('compiled',{}).get(pid,{}).get('facts',[]):
                if sum(token in compact(fact['claim']) for token in tokens)>=2:
                    compiled_sources.add((fact['source_id'],fact['page']))
        for chunk in [*data['chunks'], *derived_chunks]:
            approval = approvals.get((chunk['source_id'], chunk['page']))
            if not approval:
                continue
            source = sources[chunk['source_id']]
            if source.get('document_version') and (source['document_version'] != approval['document_version']
                                                    or source['sha256'] != approval['document_sha256']):
                continue
            related = bool(set(products) & set(source['product_ids']))
            if products and not related and source['kind'] not in ('reimbursement', 'policy', 'reviewed_content'):
                continue
            body = compact(chunk['text'])
            score = sum(1 + min(len(token), 12)/12 for token in tokens if token in body)
            if related:
                score += 8
            if (source['id'],chunk['page']) in compiled_sources:
                score += 5
            trial_names=[name for trial in source.get('trials',[]) for name in re.findall(
                r'\b(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+|monarchE|MONARCH\s*[23])\b',trial)]
            if any(compact(trial) in query for trial in trial_names if trial):
                score += 20
            if any(year in str(source.get('published_at','')) for year in re.findall(r'\b20\d{2}\b',text)):
                score += 5
            if source['kind'] == 'label' and re.search('适应|剂量|用法|禁忌|不良|安全|人群|用药', text):
                score += 3 if related else 0
            if source['kind'] in ('reimbursement','policy') and re.search('医保|报销|支付|商保', text):
                score += 8
            if score > (8 if related else 3):
                ranked.append((score, chunk, source))
        ranked.sort(key=lambda row:row[0], reverse=True)
        found, per_source = [], {}
        for score, chunk, source in ranked:
            count = per_source.get(source['id'], 0)
            if count >= 4:
                continue
            per_source[source['id']] = count+1
            found.append({**chunk, **approvals[(chunk['source_id'],chunk['page'])], 'score':round(score,2), 'source':{key:value for key,value in source.items()
                if key not in ('pages','original_path')}})
            if len(found) >= limit:
                break
        return found

    def coaching_context(self, drug, text):
        """Bounded approved excerpts; catalogue relations never grant medical approval."""
        data = self.load()
        approvals = self.approval_snapshot(data)
        names = {compact(drug.get(k, '')) for k in ('id', 'name', 'brand')} - {''}
        selected = [p for p in data['products'] if names & {compact(v) for v in
                    (p['id'], p['name'], p['brand'], *p.get('aliases', [])) if v}]
        ids = {p['id'] for p in selected}
        peers = [p for p in data['products'] if ids & set(p.get('compares_with', []))]
        query = compact(text)
        peers.sort(key=lambda p: (
            not any(compact(v) in query for v in (p['brand'], p['name'], *p.get('aliases', [])) if v),
            p.get('jurisdiction') != 'CN'))
        # Only the selected product and explicit curated peers; never all catalogue products.
        evidence = []; gaps = []
        for product in (selected + peers)[:4]:
            rows = self.search(text + ' ' + product['brand'], limit=8, data=data, approvals=approvals)
            rows = [r for r in rows if product['id'] in r['source']['product_ids']
                    and r['source']['quality'] == 'original'][:2]
            evidence.extend(rows)
            if not rows:
                gaps.append({'product': product['name'], 'reason': '缺少当前有效审核的相关原文，不能作医学比较。'})
        return {'version':data['version'], 'evidence':evidence, 'gaps':gaps}

    def validate_coaching_context(self, context):
        data = self.load()
        if data['version'] != context['version']:
            return False
        approvals = self.approval_snapshot(data)
        return all(approvals.get((row['source_id'], row['page'])) == {
            k:row[k] for k in ('document_id', 'document_version', 'version_label', 'document_sha256')
        } for row in context['evidence'])

    def source(self, source_id, version=None):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,120}',source_id):
            return None
        if source_id.startswith('platform-document-'):
            current = next((source for source in self.approved_sources() if source['id'] == source_id), None)
            return current if version is None or current and current['sha256'] == version else None
        current = next((source for source in self.load()['sources'] if source['id'] == source_id), None)
        if version is None or current and current['sha256'] == version:
            return current
        if not re.fullmatch(r'[a-f0-9]{64}',version):
            return None
        try:
            archived = json.loads((self.root/'versions'/source_id/f'{version}.json').read_text())
            return archived if archived['id'] == source_id and archived['sha256'] == version else None
        except (OSError,ValueError,KeyError,TypeError):
            return None

    def wiki_root(self):
        return self.root if (self.root/'corpus.json').exists() or self.seed is None else self.seed

    def audit(self):
        from .compile import validate_facts
        data=self.load()
        errors=[]
        verified=missing=0
        for source in data['sources']:
            path=(self.root/source['original_path']).resolve()
            if not path.is_relative_to((self.root/'raw/sources').resolve()):
                errors.append(source['id']+': 原件路径无效');continue
            if not path.is_file():
                missing+=1;continue
            if hashlib.sha256(path.read_bytes()).hexdigest()!=source['sha256']:
                errors.append(source['id']+': 原件校验值不符')
            else:
                verified+=1
        known={source['id'] for source in data['sources']}
        facts=0
        for product in data['products']:
            if any(source_id not in known for source_id in product['sources']):
                errors.append(product['id']+': 来源链接失效')
            compiled=data.get('compiled',{}).get(product['id'])
            if compiled:
                try:
                    valid,_=validate_facts(compiled,data['sources'])
                    facts+=len(valid)
                    if len(valid)!=len(compiled['facts']): errors.append(product['id']+': 编译引用失效')
                except (ValueError,TypeError,KeyError):
                    errors.append(product['id']+': 编译条目无效')
        from .wiki import lint_wiki
        errors.extend(lint_wiki(self.wiki_root()))
        return {'version':data['version'],'ok':not errors and bool(data['sources']),
            'sources':len(known),'verified_originals':verified,'originals_not_local':missing,
            'verified_fact_quotes':facts,'errors':errors,
            'scope':'仅检查文件与引用完整性，不代表医学人工审核。'}
