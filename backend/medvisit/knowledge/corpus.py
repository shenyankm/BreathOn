"""Source-bound medical evidence; generated wiki prose is never proof by itself."""
import hashlib
import json
from pathlib import Path
import re
from threading import Lock


def compact(value):
    return re.sub(r'\s+', '', value).casefold()


def quotation_text(value):
    return re.sub(r'\s+', '', value)


def sentences(text):
    return [part.strip() for part in re.split(r'(?<=[。！？!?；;])\s*|\n+', text) if part.strip()]


class MedicalCorpus:
    def __init__(self, root, *, seed=None):
        self.root = Path(root)
        self.seed = Path(seed) if seed is not None else None
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

    def search(self, text, context='', limit=12, *, data=None):
        data = self.load() if data is None else data
        query, background = compact(text), compact(context)
        explicit = [p['id'] for p in data['products'] if any(compact(alias) in query for alias in
            (p['id'], p['name'], p['brand'], *p.get('aliases', [])) if alias)]
        products = explicit or [p['id'] for p in data['products'] if any(compact(alias) in background for alias in
            (p['id'], p['name'], p['brand'], *p.get('aliases', [])) if alias)]
        tokens = set(re.findall(r'[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?', query))
        tokens.update(query[i:i+2] for i in range(len(query)-1) if all('\u4e00' <= c <= '\u9fff' for c in query[i:i+2]))
        sources = {source['id']:source for source in data['sources']}
        ranked = []
        compiled_sources = set()
        for pid in products:
            for fact in data.get('compiled',{}).get(pid,{}).get('facts',[]):
                if sum(token in compact(fact['claim']) for token in tokens)>=2:
                    compiled_sources.add((fact['source_id'],fact['page']))
        for chunk in data['chunks']:
            source = sources[chunk['source_id']]
            related = bool(set(products) & set(source['product_ids']))
            if products and not related and source['kind'] not in ('reimbursement', 'policy'):
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
            found.append({**chunk, 'score':round(score,2), 'source':{key:value for key,value in source.items()
                if key not in ('pages','original_path')}})
            if len(found) >= limit:
                break
        return found

    def source(self, source_id, version=None):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,120}',source_id):
            return None
        current=next((source for source in self.load()['sources'] if source['id'] == source_id), None)
        if version is None or current and current['sha256']==version:
            return current
        if not re.fullmatch(r'[a-f0-9]{64}',version):
            return None
        try:
            archived=json.loads((self.root/'versions'/source_id/f'{version}.json').read_text())
            return archived if archived['id']==source_id and archived['sha256']==version else None
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
        return {'version':data['version'],'ok':not errors and bool(data['sources']),
            'sources':len(known),'verified_originals':verified,'originals_not_local':missing,
            'verified_fact_quotes':facts,'errors':errors,
            'scope':'仅检查文件与引用完整性，不代表医学人工审核。'}
