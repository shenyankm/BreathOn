import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify'
import { type User, type Doc, assert, resource, identity } from './core.ts'
import { parse } from './validation.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user: User
  }
}
type Handler = (
  user: User,
  params: Doc,
  body: Doc,
  query: Doc,
  reply: FastifyReply,
  request: FastifyRequest,
) => unknown
const contract = resource('api-contract')
export function route(
  app: FastifyInstance,
  method: HTTPMethods,
  path: string,
  schema: string | undefined,
  handler: Handler,
  status = 200,
) {
  app.route({
    method,
    url: path.replace(/\{([^}]+)\}/g, ':$1'),
    handler: async (request, reply) => {
      const params = request.params as Doc,
        query = request.query as Doc
      const operation = contract.paths[path]?.[method.toLowerCase()]
      for (const parameter of operation?.parameters ?? []) {
        const input = parameter.in === 'path' ? params : query
        let value = input[parameter.name]
        const spec = parameter.schema
        assert(value !== undefined || !parameter.required, 422, '缺少请求参数。')
        if (value === undefined) {
          if ('default' in spec) input[parameter.name] = spec.default
          continue
        }
        if (spec.type === 'integer') {
          assert(/^\d+$/.test(value), 422, '请求参数须为整数。')
          value = Number(value)
          input[parameter.name] = value
        }
        assert(!spec.enum || spec.enum.includes(value), 422, '请求参数不在允许范围。')
        assert(spec.minimum === undefined || value >= spec.minimum, 422, '请求参数低于下限。')
        assert(spec.maximum === undefined || value <= spec.maximum, 422, '请求参数超过上限。')
        assert(
          spec.minLength === undefined || value.length >= spec.minLength,
          422,
          '请求参数过短。',
        )
        assert(
          spec.maxLength === undefined || value.length <= spec.maxLength,
          422,
          '请求参数过长。',
        )
        assert(
          spec.format !== 'uuid' ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
          422,
          '无效的记录标识。',
        )
      }
      const body = schema ? parse(schema, request.body) : (request.body as Doc)
      reply.code(status)
      return identity.run(request.user, () =>
        handler(request.user, params, body, query, reply, request),
      )
    },
  })
}
