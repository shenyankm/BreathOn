import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { type Doc, assert, constants, resource, unique } from './core.ts'

const schemas = resource('schemas')
const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true })
;(addFormats as unknown as (value: Ajv2020) => void)(ajv)
const validators = new Map<string, ReturnType<typeof ajv.compile>>()
export const stages = ['full', 'opening', 'needs', 'evidence', 'objections', 'safety', 'closing']
export function publicIP(host: string): boolean {
  try {
    return ipaddr.process(host).range() === 'unicast'
  } catch {
    return false
  }
}

export function publicURL(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value),
      host = url.hostname.replace(/^\[|\]$/g, '')
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !host.match(/(^localhost$|\.localhost$|\.local$|\.internal$)/i) &&
      (isIP(host) ? publicIP(host) : host.includes('.')) &&
      ![...url.searchParams.keys()].some((key) =>
        /^(token|api_key|key|secret|password|access_token|signature)$/i.test(key),
      )
    )
  } catch {
    return false
  }
}
export function department(value: string): string {
  return (
    Object.entries(constants.departments.DEPARTMENT_ALIASES).find(([, aliases]) =>
      (aliases as string[]).some((alias) => value.includes(alias)),
    )?.[0] ?? value.trim()
  )
}
export const drugDepartments = (drug: Doc): string[] =>
  drug.practice_departments ?? constants.departments.DRUG_DEPARTMENTS[drug.name] ?? []
export function matchDepartment(drug: Doc, doctor: Doc) {
  assert(
    doctor.ip_profile || drugDepartments(drug).includes(department(doctor.specialty || '')),
    409,
    '所选药品与医生科室不匹配，请重新选择对口的药品或医生。',
  )
}
export function withDepartments(kind: string, row: Doc): Doc {
  return kind === 'drug'
    ? { ...row, practice_departments: drugDepartments(row) }
    : kind === 'doctor'
      ? { ...row, practice_department: department(row.specialty || ''), any_drug: !!row.ip_profile }
      : row
}
export const usable = (item: Doc | null): boolean =>
  !!item &&
  item.status === 'approved' &&
  (!item.expires_at || Date.parse(item.expires_at) > Date.now())
export const policyUsable = (item: Doc | null): boolean =>
  usable(item) &&
  item!.legal_status === 'effective' &&
  (!item!.effective_date || item!.effective_date <= new Date().toISOString().slice(0, 10)) &&
  (!item!.end_date || item!.end_date >= new Date().toISOString().slice(0, 10))

function prepare(schema: Doc, value: any, root: Doc, key = '', trim = true): any {
  if (value === undefined && 'default' in schema) value = structuredClone(schema.default)
  if (schema.$ref) return prepare(root.$defs[schema.$ref.split('/').at(-1)], value, root, key, trim)
  if (schema.anyOf) {
    const selected = schema.anyOf.find((s: Doc) => s.type !== 'null')
    return value === null ? null : prepare(selected, value, root, key, trim)
  }
  if (value === undefined) {
    if ('default' in schema) value = structuredClone(schema.default)
    else if (schema.type === 'array') value = []
    else if (schema.type === 'object') value = {}
  }
  if (trim && typeof value === 'string' && key !== 'password') return value.trim()
  if (Array.isArray(value))
    return value.map((item, index) =>
      prepare(schema.prefixItems?.[index] ?? schema.items ?? {}, item, root, '', trim),
    )
  if (value && typeof value === 'object' && schema.properties) {
    const result = { ...value }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (name in result || !(schema.required ?? []).includes(name)) {
        const next = prepare(child as Doc, result[name], root, name, trim)
        if (next !== undefined) result[name] = next
      }
    }
    return result
  }
  return value as Doc
}
function extra(schema: Doc, value: any, root: Doc): void {
  if (!value || typeof value !== 'object') return
  if (schema.$ref) return extra(root.$defs[schema.$ref.split('/').at(-1)], value, root)
  if (schema.anyOf) {
    const child = schema.anyOf.find((s: Doc) => s.type !== 'null')
    if (child) extra(child, value, root)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, index) => extra(schema.prefixItems?.[index] ?? schema.items ?? {}, v, root))
    return
  }
  const title = schema.title ?? ''
  const check = (valid: unknown, message: string) => assert(valid, 422, message)
  for (const key of ['source_url'])
    if (value[key]) check(publicURL(value[key]), '来源必须为公开 HTTP(S) 链接。')
  if (value.sources && title.startsWith('Doctor'))
    check(value.sources.every(publicURL), '来源必须为公开 HTTP(S) 链接。')
  if (value.pages) {
    check(
      unique(value.pages.map((p: Doc) => p.number)).length === value.pages.length &&
        value.pages.reduce((n: number, p: Doc) => n + p.text.length, 0) <= 1_000_000,
      '页码必须唯一，正文总计不超过100万字符。',
    )
  }
  if (value.effective_date && value.end_date)
    check(value.effective_date <= value.end_date, '失效日期不能早于施行日期。')
  if (title.startsWith('Doctor')) {
    check(
      !value.ip_profile || value.background_type === 'fictional',
      '沟通风格角色必须是虚构背景。',
    )
    check(
      value.background_type !== 'public' || (value.sources.length && value.public_facts),
      '公开人物背景必须提供事实与来源。',
    )
  }
  if (title.startsWith('Drug') && value.practice_departments)
    value.practice_departments = unique(
      value.practice_departments.map((v: string) => {
        check(v.trim() && v.length <= 80, '科室名称必须为1至80字符。')
        return department(v)
      }),
    )
  if (value.dimensions && title.startsWith('Rubric'))
    check(
      value.dimensions.reduce((n: number, d: Doc) => n + d.weight, 0) === 100 &&
        unique(value.dimensions.map((d: Doc) => d.key)).length === value.dimensions.length,
      '权重合计必须为100，维度标识不能重复。',
    )
  if (value.anchors)
    check(
      value.anchors.every((v: string) => v.trim() && v.length <= 500),
      '每个评分锚点需为1至500字符。',
    )
  for (const key of ['content_ids', 'stages'])
    if (value[key]) check(unique(value[key]).length === value[key].length, '资料和环节不得重复。')
  for (const key of [
    'needs',
    'metrics',
    'objections',
    'success_criteria',
    'aliases',
    'diseases',
    'regions',
    'indications',
  ])
    if (value[key])
      check(
        value[key].every(
          (v: string) => v.trim() && v.length <= (['needs', 'metrics'].includes(key) ? 200 : 500),
        ),
        '列表内容为空或过长。',
      )
  if (value.sections)
    check(
      value.sections.every(
        ([a, b]: string[]) => a.trim() && b.trim() && a.length <= 120 && b.length <= 5000,
      ),
      '章节标题或正文无效。',
    )
  if (title === 'LessonAction')
    check(value.kind !== 'practice' || value.ip_id, '模拟拜访课程必须选择医生。')
  if (value.terms)
    check(
      unique(value.terms.map((t: Doc) => t.value.toLowerCase())).length === value.terms.length,
      '分类词不能重复。',
    )
  if (title === 'TrainingTemplate')
    check(
      unique(value.documents.map((d: Doc) => d.key)).length === value.documents.length &&
        canonicalIds(value.documents.map((d: Doc) => d.key)) ===
          canonicalIds(value.scenario.content_ids) &&
        Buffer.byteLength(JSON.stringify(value)) <= 7_500_000,
      '场景资料绑定或模板大小无效。',
    )
  if (title === 'Observation')
    check(Date.parse(value.observed_at) <= Date.now(), '观察时间不得晚于当前时间。')
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    if (key in value) extra(child as Doc, value[key], root)
}
const canonicalIds = (values: string[]) => JSON.stringify([...values].sort())
export function parse(name: string, input: unknown): Doc {
  const schema = schemas[name]
  assert(schema, 500, `Unknown input schema ${name}`)
  let value = structuredClone(input)
  if (
    name.startsWith('platform.models.Drug') &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value as Doc).practice_departments &&
    (value as Doc).practice_departments !== null &&
    !('practice_departments' in (value as Doc))
  )
    (value as Doc).practice_departments =
      constants.departments.DRUG_DEPARTMENTS[
        typeof (value as Doc).name === 'string' ? (value as Doc).name.trim() : ''
      ] ?? []
  value = prepare(
    schema,
    value,
    schema,
    '',
    name.startsWith('platform.') || name === 'research.models.DoctorResearchRequest',
  )
  if (name === 'research.models.ResearchRequest' && typeof (value as Doc)?.query === 'string')
    (value as Doc).query = (value as Doc).query.trim()
  let validate = validators.get(name)
  if (!validate) {
    validate = ajv.compile(schema)
    validators.set(name, validate)
  }
  assert(validate(value), 422, '输入格式无效，请检查必填内容、字段类型及长度。')
  extra(schema, value, schema)
  return value as Doc
}
export function schemaFields(name: string, value: Doc): Doc {
  return Object.fromEntries(
    Object.keys(schemas[name].properties)
      .filter((key) => key in value)
      .map((key) => [key, value[key]]),
  )
}
