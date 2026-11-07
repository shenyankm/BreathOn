import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'
import { Parser } from 'htmlparser2'
import { type Doc, assert, now, sha } from './core.ts'
import { publicURL, publicIP } from './validation.ts'
import { privateWrite } from './store.ts'
import { parseDocument } from './documents.ts'

export const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
export const normalizedText = (value: string) =>
  value.replace(/\s+/gu, (match, offset) =>
    offset &&
    offset + match.length < value.length &&
    value.charCodeAt(offset - 1) >= 48 && value.charCodeAt(offset - 1) <= 57 &&
    value.charCodeAt(offset + match.length) >= 48 && value.charCodeAt(offset + match.length) <= 57
      ? ' '
      : '',
  )
export function canonicalURL(value: string): string {
  assert(publicURL(value), 422, '仅支持不含凭据的公开 HTTP/HTTPS 来源。')
  const url = new URL(value)
  assert(!url.port || ['80', '443'].includes(url.port), 422, '公开来源仅允许标准 HTTP/HTTPS 端口。')
  url.hash = ''
  return url.href
}
export async function confined(root: string, ...parts: string[]): Promise<string> {
  const base = await realpath(root),
    path = resolve(root, ...parts),
    real = await realpath(path)
  assert(
    !relative(base, real).startsWith('..' + sep) &&
      real !== base &&
      !relative(base, real).startsWith('/'),
    409,
    '文件路径无效。',
  )
  let current = resolve(root)
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part)
    assert(!(await lstat(current)).isSymbolicLink(), 409, '不允许符号链接。')
  }
  return real
}
async function requestURL(
  url: URL,
  address: string,
  signal?: AbortSignal,
): Promise<{ raw: Buffer; headers: Doc; status: number }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'EviSpeakResearch/0.1',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        lookup: (_host, _options, callback) =>
          callback(null, address, address.includes(':') ? 6 : 4),
        signal,
        timeout: 15000,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 20_000_000) response.destroy(new Error('来源超过20MB。'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            raw: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode ?? 0,
          }),
        )
      },
    )
    request.on('timeout', () => request.destroy(new Error('来源请求超时。')))
    request.on('error', reject)
    request.end()
  })
}
export async function downloadPublic(
  value: string,
  signal?: AbortSignal,
): Promise<{ raw: Buffer; url: string; headers: Doc }> {
  let url = new URL(canonicalURL(value))
  signal = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])])
  for (let redirect = 0; redirect < 6; redirect++) {
    let addresses = (await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })).map(
      (row) => row.address,
    )
    if (addresses.length && addresses.every((address) => /^198\.(18|19)\./.test(address))) {
      const dns = new URL(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=A`,
        ),
        reply = await requestURL(dns, '1.1.1.1', signal)
      assert(reply.raw.length < 64000 && reply.status === 200, 422, '公网DNS校验失败。')
      const data = JSON.parse(reply.raw.toString())
      addresses = (data.Answer ?? [])
        .filter((row: Doc) => [1, 28].includes(row.type))
        .map((row: Doc) => row.data)
    }
    assert(
      addresses.length && addresses.every(publicIP),
      422,
      '来源域名解析到了非公开网络，已停止抓取。',
    )
    const response = await requestURL(url, addresses[0], signal)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(response.headers.location, 422, '来源重定向缺少目标地址。')
      url = new URL(canonicalURL(new URL(response.headers.location, url).href))
      continue
    }
    assert(
      response.status >= 200 && response.status < 300,
      422,
      `来源返回 HTTP ${response.status}，原文尚未获取。`,
    )
    let raw = response.raw
    const compression = response.headers['content-encoding']
    if (compression === 'gzip') raw = gunzipSync(raw, { maxOutputLength: 20_000_000 })
    else if (compression === 'deflate') raw = inflateSync(raw, { maxOutputLength: 20_000_000 })
    else if (compression === 'br') raw = brotliDecompressSync(raw, { maxOutputLength: 20_000_000 })
    assert(raw.length <= 20_000_000, 422, '原文超过20MB。')
    return { raw, url: url.href, headers: response.headers }
  }
  throw new Error('来源重定向次数过多。')
}
export function htmlText(
  raw: Buffer,
  contentType: string,
  url: string,
): { text: string; title: string; links: Doc[] } {
  const head = raw.subarray(0, 8192).toString('ascii'),
    encoding = (contentType + ' ' + head).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8'
  let html: string
  try {
    html = new TextDecoder(encoding).decode(raw)
  } catch {
    html = raw.toString('utf8')
  }
  const parts: string[] = [],
    titles: string[] = [],
    links: Doc[] = [],
    seenLinks = new Set<string>()
  const targets = new Map<string, string>()
  let skip = 0,
    inTitle = false,
    anchor: Doc | undefined
  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (['script', 'style', 'template'].includes(tag)) skip++
        if (tag === 'title') inTitle = true
        if (tag === 'a' && !skip) anchor = { url: attrs.href ?? '', title: '' }
        if (
          !skip &&
          ['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'section', 'article'].includes(tag)
        )
          parts.push('\n')
      },
      ontext(text) {
        if (!skip) {
          parts.push(text)
          if (inTitle) titles.push(text)
          if (anchor) anchor.title += text
        }
      },
      onclosetag(tag) {
        if (['script', 'style', 'template'].includes(tag) && skip) skip--
        if (tag === 'title') inTitle = false
        if (tag === 'a' && anchor) {
          try {
            let target = targets.get(anchor.url)
            if (target === undefined) {
              target = canonicalURL(new URL(anchor.url, url).href)
              targets.set(anchor.url, target)
            }
            if (target !== url && !seenLinks.has(target)) {
              seenLinks.add(target)
              links.push({ url: target, title: anchor.title.trim().slice(0, 200) })
            }
          } catch {}
          anchor = undefined
        }
        if (!skip && ['p', 'div', 'li', 'tr', 'section', 'article'].includes(tag)) parts.push('\n')
      },
    },
    { decodeEntities: true },
  )
  parser.end(html)
  return {
    text: parts
      .join('')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n'),
    title: titles.join('').trim().slice(0, 300) || url,
    links: links
      .sort(
        (a, b) =>
          Number(!a.url.toLowerCase().endsWith('.pdf')) -
            Number(!b.url.toLowerCase().endsWith('.pdf')) ||
          Number(!/附件|说明书|正文|下载/.test(a.title)) -
            Number(!/附件|说明书|正文|下载/.test(b.title)),
      )
      .slice(0, 30),
  }
}
export function evidenceBlocks(text: string, version: string): Doc[] {
  const blocks: string[] = []
  let current = ''
  for (const line of text.split(/\r?\n/)) {
    if (current.length + line.length + 1 > 700 && current) {
      blocks.push(current.trim())
      current = ''
    }
    for (let offset = 0; offset < line.length; offset += 700) {
      const part = line.slice(offset, offset + 700)
      if (part.length === 700) blocks.push(part)
      else current += part + '\n'
    }
  }
  if (current.trim()) blocks.push(current.trim())
  return blocks.map((text, index) => ({ id: `E${index + 1}-${version.slice(0, 12)}`, text }))
}
export function readerHTML(
  title: string,
  url: string,
  time: string,
  sections: [string, string][],
): string {
  return (
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{max-width:900px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><title>' +
    escapeHTML(title) +
    '</title><h1>' +
    escapeHTML(title) +
    '</h1><p>抓取时间：' +
    escapeHTML(time) +
    ' · 自动归档，待专业核对</p><p><a rel="noreferrer noopener" href="' +
    escapeHTML(url) +
    '">原文来源</a></p>' +
    sections
      .map(
        ([label, text]) =>
          `<section><h2>${escapeHTML(label)}</h2><pre>${escapeHTML(text)}</pre></section>`,
      )
      .join('') +
    '</html>'
  )
}
export async function archiveSource(
  root: string,
  value: string,
  signal?: AbortSignal,
): Promise<{ metadata: Doc; text: string }> {
  const url = canonicalURL(value),
    download = await downloadPublic(url, signal),
    id = sha(url).slice(0, 24),
    version = sha(download.raw),
    folder = join(root, id, version)
  let text: string,
    title: string,
    kind: string,
    links: Doc[] = [],
    sections: [string, string][]
  if (download.raw.subarray(0, 5).toString() === '%PDF-') {
    const data = await parseDocument(download.raw, 'pdf', signal)
    sections = data.pages.map((p: Doc) => [`第 ${p.number} 页`, p.text])
    text = sections.map(([a, b]) => a + '\n' + b).join('\n\n')
    title = new URL(download.url).pathname.split('/').at(-1) || 'PDF原文'
    kind = 'pdf'
  } else if (
    download.raw.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' ||
    download.raw.subarray(0, 2).toString() === 'PK'
  ) {
    kind = download.raw.subarray(0, 2).toString() === 'PK' ? 'docx' : 'doc'
    text = (await parseDocument(download.raw, kind as 'doc' | 'docx', signal)).text
    title = new URL(download.url).pathname.split('/').at(-1) || 'Word原文'
    sections = [['Word原文正文', text]]
  } else {
    assert(
      /text\/html|application\/xhtml\+xml/i.test(download.headers['content-type'] ?? ''),
      422,
      '仅归档HTML网页、PDF与DOC/DOCX原文。',
    )
    const parsed = htmlText(download.raw, download.headers['content-type'], download.url)
    ;({ text, title, links } = parsed)
    kind = 'html'
    sections = [['原文正文', text]]
  }
  assert(
    text.trim().length >= 40,
    422,
    '未获取到足够的原文正文，需核对动态页面、访问验证或扫描件。',
  )
  const metadata = {
    id,
    url,
    resolved_url: download.url,
    title,
    kind,
    retrieved_at: now(),
    raw_sha256: version,
    text_sha256: sha(normalizedText(text)),
    headers: download.headers,
    original_file: `original.${kind}`,
    reader_file: 'reader.html',
    text_file: 'content.txt',
    links,
  }
  try {
    const existing = await readSource(root, id, version)
    if (existing.metadata.resolved_url === download.url)
      return {
        ...existing,
        metadata: { ...existing.metadata, retrieved_at: now(), headers: download.headers },
      }
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
  }
  await privateWrite(join(folder, metadata.original_file), download.raw)
  await privateWrite(join(folder, 'content.txt'), text)
  await privateWrite(
    join(folder, 'reader.html'),
    readerHTML(title, download.url, metadata.retrieved_at, sections),
  )
  await privateWrite(join(folder, 'metadata.json'), JSON.stringify(metadata))
  return { metadata, text }
}
export async function readSource(
  root: string,
  id: string,
  version: string,
): Promise<{ metadata: Doc; text: string }> {
  assert(/^[a-f0-9]{24}$/.test(id) && /^[a-f0-9]{64}$/.test(version), 422, '原文标识无效。')
  const metadata = JSON.parse(
    await readFile(await confined(root, id, version, 'metadata.json'), 'utf8'),
  )
  assert(
    metadata.id === id &&
      metadata.raw_sha256 === version &&
      ['html', 'pdf', 'doc', 'docx'].includes(metadata.kind) &&
      metadata.original_file === `original.${metadata.kind}` &&
      metadata.reader_file === 'reader.html' &&
      metadata.text_file === 'content.txt',
    409,
    '已归档的原文元数据损坏，请人工核对。',
  )
  const original = await readFile(await confined(root, id, version, metadata.original_file)),
    text = await readFile(await confined(root, id, version, 'content.txt'), 'utf8')
  await confined(root, id, version, 'reader.html')
  assert(
    sha(original) === version &&
      text.trim().length >= 40 &&
      sha(normalizedText(text)) === metadata.text_sha256,
    409,
    '已归档的原文正文或校验信息损坏，请人工核对。',
  )
  return { metadata, text }
}
