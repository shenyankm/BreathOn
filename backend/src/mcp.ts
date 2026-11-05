import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import { settings, assert } from './core.ts'
import { Models } from './agents.ts'
import { ResearchTools } from './research.ts'

const config = settings(),
  root = process.env.MEDVISIT_RESEARCH_ARCHIVES,
  folder = process.env.MEDVISIT_RESEARCH_JOB
assert(root && folder, 500, 'Research archive and job directories must be configured by the host')
const tools = new ResearchTools(
  new Models(config),
  resolve(root),
  resolve(folder),
  JSON.parse(process.env.MEDVISIT_RESEARCH_SEEDS ?? '[]'),
).tools()
const server = new Server(
  { name: 'EviSpeak public research', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name.replace('mcp__medvisit_research__', ''),
    description: tool.description,
    inputSchema: tool.parameters,
  })),
}))
server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  const tool = tools.find((tool) => tool.name === `mcp__medvisit_research__${request.params.name}`)
  assert(tool, 422, 'Unknown research tool')
  try {
    const result = await tool.execute(
      String(context.requestId),
      request.params.arguments ?? {},
      context.signal,
    )
    return { content: result.content }
  } catch {
    return {
      content: [{ type: 'text', text: '工具未完成，请核对参数与来源；未扩大工具权限。' }],
      isError: true,
    }
  }
})
await server.connect(new StdioServerTransport())
