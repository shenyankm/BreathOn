import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { type Doc, assert, sha, uuid } from './core.ts'
import { Store } from './store.ts'
import { usable, policyUsable } from './validation.ts'
import { Catalog } from './catalog.ts'
import { route } from './http.ts'

export async function parseDocument(
  raw: Buffer,
  kind: 'pdf' | 'doc' | 'docx',
  signal?: AbortSignal,
): Promise<Doc> {
  assert(raw.length <= 20_000_000, 413, '文档超过20MB。')
  const python = new URL('../.venv/bin/python', import.meta.url).pathname
  const executable = process.env.DOCUMENT_PYTHON || (existsSync(python) ? python : 'python3')
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [new URL(`../parsers/${kind === 'pdf' ? 'pdf' : 'word'}.py`, import.meta.url).pathname],
      {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'ignore'],
        signal,
        timeout: 22000,
        killSignal: 'SIGKILL',
      },
    )
    const chunks: Buffer[] = []
    let size = 0,
      overflow = false
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 8_000_000) {
        overflow = true
        child.kill('SIGKILL')
      } else chunks.push(chunk)
    })
    child.on('error', () => reject(new Error('文档解析进程无法启动。')))
    child.on('close', (code) => {
      try {
        assert(!code && !overflow, 422, '文档无法安全解析，请检查文件、页数或改用文本录入。')
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        assert(!data.error, 422, data.error)
        resolve(data)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(raw)
  })
}
export function registerDocuments(app: FastifyInstance, store: Store, catalog: Catalog) {
  route(
    app,
    'POST',
    '/api/content/pdf',
    undefined,
    async (u, _p, _b, _q, _reply, request) => {
      assert(
        request.headers['content-type'] === 'application/pdf',
        415,
        '请使用 application/pdf 上传。',
      )
      const raw = request.body as Buffer
      assert(
        Buffer.isBuffer(raw) && raw.subarray(0, 5).toString() === '%PDF-',
        422,
        '请上传20MB以内的PDF文件。',
      )
      const result = await parseDocument(raw, 'pdf')
      return store.transaction(u.workspace, async (tx) => {
        const asset = await tx.create(u.workspace, 'asset', {
          data: raw.toString('base64'),
          sha256: sha(raw),
          size: raw.length,
          created_by: u.id,
        })
        await tx.audit(u, 'content.upload', 'asset', asset.id)
        return { ...result, asset_id: asset.id, sha256: asset.sha256 }
      })
    },
    201,
  )
  route(
    app,
    'GET',
    '/api/catalog/{kind}/{item_id}/file',
    undefined,
    async (u, p, _b, _q, reply) => {
      const item = await catalog.get(u, p.kind, p.item_id)
      assert(['content', 'policy'].includes(p.kind) && item.asset_id, 404, '此版本没有PDF原件。')
      assert(
        u.role === 'admin' || (p.kind === 'policy' ? policyUsable(item) : usable(item)),
        404,
        '记录不存在。',
      )
      const asset = await store.transaction(
          u.workspace,
          (tx) => tx.require(u.workspace, 'asset', item.asset_id),
          false,
        ),
        raw = Buffer.from(asset.data, 'base64')
      assert(
        raw.length === asset.size && sha(raw) === asset.sha256,
        409,
        'PDF原件损坏或校验失败，请从备份恢复或重新上传。',
      )
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="document-${uuid()}.pdf"`)
        .send(raw)
    },
  )
}
