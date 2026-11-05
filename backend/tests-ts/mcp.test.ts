import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('actual STDIO MCP exposes only research tools and refuses arbitrary private network archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evispeak-mcp-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-transform-types', new URL('../src/mcp.ts', import.meta.url).pathname],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MEDVISIT_RESEARCH_ARCHIVES: join(root, 'sources'),
      MEDVISIT_RESEARCH_JOB: join(root, 'job'),
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'synthetic-qa', version: '1.0.0' })
  try {
    await client.connect(transport)
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      'archive_source',
      'read_archive',
      'search_public',
    ])
    const result = await client.callTool({
      name: 'archive_source',
      arguments: { url: 'http://127.0.0.1/private' },
    })
    assert.match(JSON.stringify(result), /error/)
    const unknown = await client
      .callTool({ name: 'run_shell', arguments: { command: 'echo forbidden' } })
      .catch((error) => error)
    assert(unknown instanceof Error)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
  }
})
