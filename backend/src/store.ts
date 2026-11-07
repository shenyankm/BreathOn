import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, open, readFile, readdir, rename, unlink, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Pool } from 'pg'
import {
  type Doc,
  type User,
  HttpError,
  Semaphore,
  identity,
  now,
  uuid,
  canonical,
  sha,
  pick,
  assert,
} from './core.ts'

export async function privateWrite(path: string, data: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${uuid()}.tmp`
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
    await file.close()
    await rename(temp, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}
const visible = (kind: string, item: Doc) => {
  const user = identity.getStore(),
    key = ({ case: 'created_by', remediation: 'owner_id', member_state: 'owner_id', learning_event: 'owner_id' } as Doc)[kind]
  return !user?.authenticated || !key || item[key] === user.id
}
export class Transaction {
  constructor(
    private execute: (sql: string, values?: any[]) => Promise<Doc[]>,
    private postgres = false,
  ) {}
  async all(kind: string, tenant?: string): Promise<{ tenant: string; item: Doc }[]> {
    return (
      await this.execute(`SELECT tenant_id,document FROM platform_entities WHERE kind=?${tenant === undefined ? '' : ' AND tenant_id=?'}`,
        tenant === undefined ? [kind] : [kind, tenant])
    ).map((row) => ({ tenant: row.tenant_id, item: JSON.parse(row.document) }))
  }
  async get(tenant: string, kind: string, id: string, withoutPages = false): Promise<Doc | null> {
    const document = withoutPages
      ? this.postgres ? "(document::jsonb - 'pages')::text" : "json_remove(document,'$.pages')"
      : 'document'
    const rows = await this.execute(
      `SELECT ${document} AS document FROM platform_entities WHERE tenant_id=? AND kind=? AND id=?`,
      [tenant, kind, id],
    )
    const item = rows[0] ? JSON.parse(rows[0].document) : null
    return item && visible(kind, item) ? item : null
  }
  async require(tenant: string, kind: string, id: string): Promise<Doc> {
    const item = await this.get(tenant, kind, id)
    if (!item || item.status === 'deleted')
      throw new HttpError(404, '记录不存在或不属于当前工作区。')
    return item
  }
  async list(tenant: string, kind: string, withoutPages = false): Promise<Doc[]> {
    const document = withoutPages
      ? this.postgres ? "(document::jsonb - 'pages')::text" : "json_remove(document,'$.pages')"
      : 'document'
    const rows = await this.execute(
      `SELECT ${document} AS document FROM platform_entities WHERE tenant_id=? AND kind=? ORDER BY updated_at DESC,id`,
      [tenant, kind],
    )
    return rows.map((row) => JSON.parse(row.document)).filter((row) => visible(kind, row))
  }
  async create(tenant: string, kind: string, data: Doc, id: string = uuid()): Promise<Doc> {
    const item = { ...data, id, version: 1, created_at: now(), updated_at: now() }
    try {
      await this.execute(
        'INSERT INTO platform_entities (tenant_id,kind,id,version,document,updated_at) VALUES (?,?,?,?,?,?)',
        [tenant, kind, id, 1, JSON.stringify(item), item.updated_at],
      )
    } catch (error: any) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE constraint'))
        throw new HttpError(409, '记录已存在，请刷新后重试。')
      throw error
    }
    return item
  }
  async update(tenant: string, kind: string, id: string, data: Doc, version: number): Promise<Doc> {
    const old = await this.get(tenant, kind, id)
    if (!old || old.version !== version) throw new HttpError(409, '记录已被修改，请刷新后重试。')
    const item = {
      ...data,
      id,
      created_at: old.created_at,
      updated_at: now(),
      version: version + 1,
    }
    const rows = await this.execute(
      'UPDATE platform_entities SET document=?,version=?,updated_at=? WHERE tenant_id=? AND kind=? AND id=? AND version=? RETURNING id',
      [JSON.stringify(item), item.version, item.updated_at, tenant, kind, id, version],
    )
    if (!rows.length) throw new HttpError(409, '记录已被修改，请刷新后重试。')
    return item
  }
  audit(user: User, action: string, kind: string, id: string, detail: Doc = {}) {
    return this.create(user.workspace, 'audit', {
      actor_id: user.id,
      action,
      kind,
      object_id: id,
      detail,
    })
  }
}
export class Store {
  private db?: DatabaseSync
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  private pool?: Pool
  private lock = new Semaphore(1)
  workspace = 'local'
  constructor(readonly config: Doc) {}
  async open() {
    await mkdir(this.config.records, { recursive: true, mode: 0o700 })
    if (this.config.database) {
      this.pool = new Pool({
        connectionString: this.config.database,
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      })
      this.pool.on('error', () => {
        console.error('database_idle_connection_failed')
      })
      for (const name of ['001_sessions.sql', '002_platform.sql'])
        await this.pool.query(
          await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
        )
    } else {
      const path = join(this.config.records, 'platform.sqlite3')
      this.db = new DatabaseSync(path)
      await chmod(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      this.db.exec(
        await readFile(new URL('../migrations/002_platform.sql', import.meta.url), 'utf8'),
      )
    }
    const setup = await this.transaction('', (tx) => tx.get('', 'system', 'setup'), false)
    if (setup) this.workspace = setup.workspace
  }
  async transaction<T>(
    tenant: string,
    work: (tx: Transaction) => Promise<T>,
    write = true,
  ): Promise<T> {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (write)
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant])
        const tx = new Transaction(async (sql, values = []) => {
          let index = 0
          return (
            await client.query(
              sql.replace(/\?/g, () => `$${++index}`),
              values,
            )
          ).rows
        }, true)
        const value = await work(tx)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }
    return this.lock.run(async () => {
      this.db!.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
      try {
        const tx = new Transaction(async (sql, values = []) => {
          let statement = this.statements.get(sql)
          if (!statement) {
            statement = this.db!.prepare(sql)
            if (this.statements.size >= 64) this.statements.clear()
            this.statements.set(sql, statement)
          }
          return /^(SELECT|.*RETURNING )/is.test(sql)
            ? (statement.all(...values) as Doc[])
            : (statement.run(...values), [])
        })
        const value = await work(tx)
        this.db!.exec('COMMIT')
        return value
      } catch (error) {
        this.db!.exec('ROLLBACK')
        throw error
      }
    })
  }
  async check() {
    if (this.pool) await this.pool.query('SELECT 1')
    else
      await this.lock.run(async () => {
        this.db!.prepare('SELECT id FROM platform_entities LIMIT 1').all()
      })
    const path = join(this.config.records, `.probe-${uuid()}`)
    await privateWrite(path, 'ready')
    await unlink(path)
  }
  async close() {
    if (this.pool) await this.pool.end()
    if (this.db) await this.lock.run(async () => {
      this.statements.clear()
      this.db!.close()
    })
  }
  async saveRecord(record: Doc, status: string, onlyIfAbsent = false): Promise<Doc> {
    record.status = status
    record.ended_at ??= now()
    record.activity = activity(record)
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO sessions (id,document) VALUES ($1,$2) ON CONFLICT (id) ${onlyIfAbsent ? 'DO NOTHING' : 'DO UPDATE SET document=EXCLUDED.document,saved_at=now()'}`,
        [record.id, record],
      )
      if (!onlyIfAbsent) return record
      const saved = await this.record(record.id)
      assert(saved, 503, '恢复记录尚未确认写入。')
      return saved
    }
    return this.lock.run(async () => {
      if (onlyIfAbsent) {
        const existing = await this.record(record.id)
        if (existing) return existing
      }
      await privateWrite(join(this.config.records, `${record.id}.json`), JSON.stringify(record))
      return record
    })
  }
  async record(id: string): Promise<Doc | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    if (this.pool)
      return (
        (await this.pool.query('SELECT document FROM sessions WHERE id=$1', [id])).rows[0]
          ?.document ?? null
      )
    try {
      return JSON.parse(await readFile(join(this.config.records, `${id}.json`), 'utf8'))
    } catch (error: any) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  async records(user?: User, limit: number | null = 50): Promise<Doc[]> {
    let rows: Doc[] = []
    if (this.pool) {
      const values: any[] = []
      let where = ''
      if (user?.authenticated) {
        values.push(user.workspace, user.id)
        where = " WHERE document->>'workspace'=$1 AND document->>'owner_id'=$2"
      }
      rows = (
        await this.pool.query(
          `SELECT document FROM sessions${where} ORDER BY saved_at DESC,id DESC${limit === null ? '' : ` LIMIT $${values.length + 1}`}`,
          limit === null ? values : [...values, limit],
        )
      ).rows.map((row) => row.document)
    } else {
      const files = (await readdir(this.config.records)).filter(file => /^[0-9a-f-]{36}\.json$/i.test(file))
      for (let offset = 0; offset < files.length; offset += 8) {
        const batch = await Promise.all(files.slice(offset, offset + 8).map(async file => {
          try {
            const row = await this.record(file.slice(0, -5))
            if (row?.id === file.slice(0, -5) && Array.isArray(row.messages) && typeof row.started_at === 'string')
              return row
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
          }
          return null
        }))
        rows.push(...batch.filter((row): row is Doc => row !== null))
      }
    }
    rows = rows
      .filter(
        (row) =>
          !user?.authenticated || (row.workspace === user.workspace && row.owner_id === user.id),
      )
      .sort((a, b) => (b.ended_at || b.started_at).localeCompare(a.ended_at || a.started_at))
    return limit === null ? rows : rows.slice(0, limit)
  }
  async ownRecord(user: User, id: string): Promise<Doc> {
    const record = await this.record(id)
    if (
      !record ||
      (user.authenticated && (record.workspace !== user.workspace || record.owner_id !== user.id))
    )
      throw new HttpError(404, '记录不存在。')
    return record
  }
  async importRecords(directory: string): Promise<{ imported: number; existing: number }> {
    assert(this.pool, 400, '恢复导入需要配置 PostgreSQL。')
    const records: { data: Doc; saved: Date }[] = []
    for (const file of await readdir(directory)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(file))
        continue
      const path = join(directory, file),
        info = await lstat(path)
      assert(info.isFile() && !info.isSymbolicLink(), 422, '恢复记录必须是普通文件。')
      const data = JSON.parse(await readFile(path, 'utf8'))
      assert(
        data?.id === file.slice(0, -5) &&
          Array.isArray(data.messages) &&
          ['assisted', 'independent'].includes(data.mode) &&
          typeof data.started_at === 'string' &&
          typeof data.ended_at === 'string',
        422,
        '恢复记录结构无效；未导入任何记录。',
      )
      records.push({ data, saved: info.mtime })
    }
    const client = await this.pool.connect()
    let imported = 0
    try {
      await client.query('BEGIN')
      for (const record of records) {
        const result = await client.query(
          'INSERT INTO sessions (id,document,saved_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
          [record.data.id, record.data, record.saved],
        )
        imported += result.rowCount ?? 0
      }
      await client.query('COMMIT')
      return { imported, existing: records.length - imported }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}
export function newRecord(user: User, experience: string, mode: string): Doc {
  return {
    id: uuid(),
    workspace: user.workspace,
    owner_id: user.id,
    team: user.team,
    experience,
    mode,
    started_at: now(),
    ended_at: null,
    status: 'active',
    messages: [],
    coaching: [],
    interactions: [],
    usage: [],
  }
}
export function trainingFingerprint(training: Doc | undefined): string | null {
  if (!training) return null
  const captured: Doc = {}
  for (const kind of ['scenario', 'doctor']) {
    const item = training[kind] ?? {}
    if (!item.id || !item.version) return null
    captured[kind] = [item.id, item.version]
  }
  const rubric = training.rubric
  if (!rubric?.id || !Array.isArray(rubric.dimensions) || !rubric.dimensions.length) return null
  // Calibration bookkeeping changes the entity version, but not the training conditions.
  captured.rubric = [rubric.id, sha(canonical(rubric.dimensions))]
  for (const kind of ['drugs', 'policies']) {
    const items = training[kind] ?? []
    if (!Array.isArray(items) || items.some((item: Doc) => !item?.id || !item.version)) return null
    captured[kind] = items.map((item: Doc) => [item.id, item.version])
      .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])))
  }
  const documents = training.documents ?? []
  if (!Array.isArray(documents) || documents.some((doc: Doc) => !doc?.id || !doc.version || !doc.sha256)) return null
  captured.documents = documents
    .map((doc: Doc) => [doc.id, doc.version, doc.sha256])
    .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])))
  return sha(canonical(captured))
}
export function activity(record: Doc): Doc {
  const review = [...(record.coaching ?? [])].reverse().find((row: Doc) => row.final_report) ?? {},
    assessment = review.assessment ?? {},
    training = record.training ?? {}
  const trainee = (record.messages ?? []).filter(
      (m: Doc) => m.role === 'trainee' && m.text?.trim(),
    ),
    text = trainee.map((m: Doc) => m.text.trim()).join('\n')
  const valid =
    record.status === 'completed' &&
    record.capture_status === 'completed' &&
    record.analysis_status === 'completed' &&
    !!Object.keys(review).length &&
    !review.incomplete &&
    trainee.length > 0 &&
    trainee.at(-1).final === true &&
    review.based_on === trainee.at(-1).id &&
    text.length >= 10 &&
    !!Object.keys(assessment).length &&
    !assessment.validation_errors?.length
  return {
    ...pick(record, [
      'id',
      'workspace',
      'owner_id',
      'team',
      'started_at',
      'ended_at',
      'status',
      'capture_status',
      'analysis_status',
      'experience',
      'remediation_id',
      'remediation_phase',
    ]),
    format: 2,
    valid: !!valid,
    trainee_characters: text.length,
    training_fingerprint: trainingFingerprint(record.training),
    transcript_hash: sha(text),
    scenario_id: training.scenario?.id ?? null,
    scenario_title: training.scenario?.title ?? null,
    stage: training.stage ?? null,
    assessment: {
      ...pick(assessment, [
        'total',
        'status',
        'model',
        'evaluator_version',
        'rubric_id',
        'rubric_name',
        'rubric_fingerprint',
        'calibration_status',
        'observed_weight',
      ]),
      dimensions: (assessment.dimensions ?? []).map((d: Doc) =>
        pick(d, ['key', 'label', 'weight', 'score']),
      ),
    },
  }
}
