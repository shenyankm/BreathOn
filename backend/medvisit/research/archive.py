"""Bounded public downloads and immutable originals plus a script-free HTML reader."""
import asyncio
import hashlib
import html
from html.parser import HTMLParser
import ipaddress
import json
from pathlib import Path
import re
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from ..agents.web_search import public_url
from ..platform.pdf_extract import extract_pdf
from ..platform.store import now
from ..storage.records import write_private
from .word_extract import extract_word

MAX_BYTES = 20_000_000


def normalized_text(value):
    # Ignore document wrapping without merging two distinct numeric tokens.
    return re.sub(r'\s+', lambda match: ' ' if match.start() and match.end() < len(value)
        and value[match.start()-1].isdigit() and value[match.end()].isdigit() else '', value)


def evidence_blocks(text, version):
    blocks, current = [], ''
    for line in text.splitlines():
        if len(current)+len(line)+1 > 700 and current:
            blocks.append(current.strip())
            current = ''
        for offset in range(0, len(line), 700):
            part = line[offset:offset+700]
            if len(part) == 700:
                blocks.append(part)
            else:
                current += part+'\n'
    if current.strip():
        blocks.append(current.strip())
    return [{'id':f'E{index+1}-{version[:12]}', 'text':block} for index, block in enumerate(blocks)]


def canonical_url(value):
    if not public_url(value):
        raise ValueError('仅支持不含凭据的公开 HTTP/HTTPS 来源。')
    parsed = urlsplit(value)
    if parsed.port not in (None, 80, 443):
        raise ValueError('公开来源仅允许标准 HTTP/HTTPS 端口。')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, ''))


async def resolve_public(host, port):
    rows = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = {row[4][0] for row in rows}
    # TUN proxies may return benchmarking-range fake IPs; resolve the real target through pinned, TLS-verified DoH.
    if addresses and all(ipaddress.ip_address(address) in ipaddress.ip_network('198.18.0.0/15') for address in addresses):
        return await resolve_public_doh(host)
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError('来源域名解析到了非公开网络，已停止抓取。')
    return sorted(addresses, key=lambda address: (':' in address, address))[0]


async def resolve_public_doh(host):
    name = host.encode('idna').decode()
    async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
        for record_type in ('A', 'AAAA'):
            response = await client.get('https://1.1.1.1/dns-query', params={'name':name, 'type':record_type},
                headers={'Host':'cloudflare-dns.com', 'Accept':'application/dns-json'},
                extensions={'sni_hostname':'cloudflare-dns.com'})
            response.raise_for_status()
            if len(response.content) > 64000:
                raise ValueError('公网DNS响应过大。')
            payload = response.json()
            if payload.get('Status') != 0:
                raise ValueError('未能从公网DNS核对来源地址。')
            addresses = {answer['data'] for answer in payload.get('Answer', []) if answer.get('type') in (1, 28)}
            if addresses:
                if any(not ipaddress.ip_address(address).is_global for address in addresses):
                    raise ValueError('来源的公网DNS结果不是公开地址，已停止抓取。')
                return sorted(addresses, key=lambda address: (':' in address, address))[0]
    raise ValueError('来源没有可核对的公网地址。')


async def download_public(url, *, max_bytes=MAX_BYTES):
    url = canonical_url(url)
    async with asyncio.timeout(45), httpx.AsyncClient(timeout=httpx.Timeout(15, connect=8), trust_env=False) as client:
        for _ in range(6):
            target = httpx.URL(url)
            address = await resolve_public(target.host, target.port or (443 if target.scheme == 'https' else 80))
            # Pin the validated address; retain the origin Host and TLS SNI to prevent DNS rebinding.
            async with client.stream('GET', target.copy_with(host=address),
                    headers={'Host': target.netloc.decode(), 'User-Agent': 'MedcoachResearch/0.1', 'Accept': '*/*'},
                    extensions={'sni_hostname': target.host}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get('location')
                    if not location:
                        raise ValueError('来源重定向缺少目标地址。')
                    url = canonical_url(urljoin(url, location))
                    continue
                response.raise_for_status()
                size = response.headers.get('content-length', '')
                if size.isdecimal() and int(size) > max_bytes:
                    raise ValueError(f'原文超过{max_bytes//1_000_000}MB，未归档不完整文件。')
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError(f'原文超过{max_bytes//1_000_000}MB，未归档不完整文件。')
                    chunks.append(chunk)
                return b''.join(chunks), url, {
                    key: response.headers.get(key, '')[:1000] for key in ('content-type', 'etag', 'last-modified')
                }
    raise ValueError('来源重定向次数过多。')


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.titles = [], []
        self.skip = 0
        self.in_title = False
        self.links = []
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'template'):
            self.skip += 1
        if tag == 'title':
            self.in_title = True
        if tag == 'a' and not self.skip:
            self.anchor = {'url':dict(attrs).get('href', ''), 'text':[]}
        if not self.skip and tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'section', 'article'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'template') and self.skip:
            self.skip -= 1
        if tag == 'title':
            self.in_title = False
        if tag == 'a' and self.anchor is not None:
            self.links.append({'url':self.anchor['url'], 'title':''.join(self.anchor['text']).strip()[:200]})
            self.anchor = None
        if not self.skip and tag in ('p', 'div', 'li', 'tr', 'section', 'article'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)
            if self.in_title:
                self.titles.append(data)
            if self.anchor is not None:
                self.anchor['text'].append(data)

    @property
    def text(self):
        return '\n'.join(line.strip() for line in ''.join(self.parts).splitlines() if line.strip())


def decode_html(data, content_type):
    head = data[:8192].decode('ascii', errors='ignore')
    match = re.search(r'charset\s*=\s*["\']?([\w-]+)', content_type + ' ' + head, re.I)
    encoding = match.group(1) if match else 'utf-8'
    try:
        return data.decode(encoding, errors='replace')
    except LookupError:
        return data.decode('utf-8', errors='replace')


def reader_html(title, url, checked_at, sections, kind):
    format_note = {'pdf':'PDF文字转成HTML，PDF原件另存', 'doc':'Word文字转成HTML，版式与页码以原件为准',
        'docx':'Word文字转成HTML，版式与页码以原件为准', 'html':'网页文字阅读副本，原始HTML另存'}[kind]
    blocks = ''.join(f'<section><h2>{html.escape(label)}</h2><pre>{html.escape(text)}</pre></section>' for label, text in sections)
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)}</title><style>body{{max-width:900px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui}}'
        'pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font-size:24px}h2{font-size:18px}.meta{color:#555}</style>'
        f'<h1>{html.escape(title)}</h1><p class="meta">抓取时间：{html.escape(checked_at)} · '
        f'{format_note} · 待专业核对</p>'
        f'<p>原文来源：<a href="{html.escape(url, quote=True)}" rel="noreferrer noopener" target="_blank">{html.escape(url)}</a></p>'
        + blocks + '</html>').encode()


async def archive_source(root: Path, url: str):
    url = canonical_url(url)
    data, resolved_url, headers = await download_public(url)
    source_id = hashlib.sha256(url.encode()).hexdigest()[:24]
    raw_hash = hashlib.sha256(data).hexdigest()
    folder = root / source_id / raw_hash
    if (folder / 'metadata.json').exists():
        cached, text = await asyncio.to_thread(read_source, root, source_id, raw_hash)
        if cached.get('resolved_url') == resolved_url and cached['headers'].get('content-type') == headers.get('content-type'):
            return {**cached, 'retrieved_at':now(), 'headers':headers}, text
    links = []
    if data.startswith(b'%PDF-'):
        parsed = await asyncio.to_thread(extract_pdf, data)
        sections = [(f'第 {page["number"]} 页', page['text']) for page in parsed['pages']]
        title, kind = urlsplit(resolved_url).path.rsplit('/', 1)[-1] or 'PDF原文', 'pdf'
        text = '\n\n'.join(f'{label}\n{content}' for label, content in sections)
    elif data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')) or data.startswith(b'PK'):
        text = await asyncio.to_thread(extract_word, data)
        title = urlsplit(resolved_url).path.rsplit('/', 1)[-1] or 'Word原文'
        kind = 'docx' if data.startswith(b'PK') else 'doc'
        sections = [('Word原文正文', text)]
    else:
        content_type = headers.get('content-type', '').lower()
        if not any(mime in content_type for mime in ('text/html', 'application/xhtml+xml')):
            raise ValueError('仅归档HTML网页、PDF与DOC/DOCX原文。')
        parser = PageText()
        parser.feed(decode_html(data, content_type))
        text = parser.text
        title, kind = ''.join(parser.titles).strip()[:300] or resolved_url, 'html'
        sections = [('原文正文', text)]
        found = {}
        for link in parser.links:
            try:
                target = canonical_url(urljoin(resolved_url, link['url']))
            except ValueError:
                continue
            if target != url:
                found.setdefault(target, {**link, 'url':target})
        links = sorted(found.values(), key=lambda link: (
            not urlsplit(link['url']).path.lower().endswith('.pdf'),
            not bool(re.search('附件|说明书|正文|下载', link['title']))))[:30]
    if len(text.strip()) < 40:
        raise ValueError('未获取到足够的原文正文，需核对动态页面、访问验证或扫描件。')
    checked_at = now()
    metadata = {'id': source_id, 'url': url, 'resolved_url': resolved_url, 'title': title, 'kind': kind,
        'retrieved_at': checked_at, 'raw_sha256': raw_hash,
        'text_sha256': hashlib.sha256(normalized_text(text).encode()).hexdigest(), 'headers': headers,
        'original_file': f'original.{kind}', 'reader_file': 'reader.html', 'text_file': 'content.txt', 'links':links}
    if not (folder / 'metadata.json').exists():
        write_private(folder / metadata['original_file'], data)
        write_private(folder / 'content.txt', text.encode())
        write_private(folder / 'reader.html', reader_html(title, resolved_url, checked_at, sections, kind))
        write_private(folder / 'metadata.json', json.dumps(metadata, ensure_ascii=False).encode())
    return metadata, text


def read_source(root: Path, source_id, version):
    if (not isinstance(source_id, str) or not isinstance(version, str)
            or not re.fullmatch(r'[a-f0-9]{24}', source_id) or not re.fullmatch(r'[a-f0-9]{64}', version)):
        raise ValueError('原文标识无效。')
    folder = root / source_id / version
    metadata = json.loads((folder / 'metadata.json').read_text())
    if (not isinstance(metadata, dict) or metadata.get('id') != source_id or metadata.get('raw_sha256') != version
            or not isinstance(metadata.get('headers'), dict) or metadata.get('kind') not in ('html', 'pdf', 'doc', 'docx')
            or metadata.get('original_file') != f'original.{metadata["kind"]}'
            or metadata.get('reader_file') != 'reader.html' or metadata.get('text_file') != 'content.txt'):
        raise ValueError('已归档的原文元数据损坏，请人工核对。')
    if not all((folder / filename).is_file() for filename in (metadata['original_file'], 'reader.html')):
        raise ValueError('已归档的原文文件不完整，请人工核对。')
    with (folder / metadata['original_file']).open('rb') as original:
        if hashlib.file_digest(original, 'sha256').hexdigest() != version:
            raise ValueError('已归档的原文文件损坏，请人工核对。')
    text = (folder / 'content.txt').read_text()
    if len(text.strip()) < 40 or metadata.get('text_sha256') != hashlib.sha256(normalized_text(text).encode()).hexdigest():
        raise ValueError('已归档的原文正文或校验信息损坏，请人工核对。')
    return metadata, text
