import { mkdir, open, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { assert, settings } from './core.ts'
import { synthesize } from './voice-protocol.ts'

export function resample(pcm: Buffer): Buffer {
  assert(pcm.length % 2 === 0, 422, 'PCM must contain int16 samples')
  const chunks: number[] = []
  for (let i = 0; i + 6 <= pcm.length; i += 6)
    chunks.push(
      pcm.readInt16LE(i),
      Math.floor((pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 4)) / 2),
    )
  const result = Buffer.alloc(chunks.length * 2)
  chunks.forEach((value, index) => result.writeInt16LE(value, index * 2))
  return result
}
export function silentWav(): Buffer {
  const result = Buffer.alloc(32044)
  result.write('RIFF')
  result.writeUInt32LE(result.length - 8, 4)
  result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16)
  result.writeUInt16LE(1, 20)
  result.writeUInt16LE(1, 22)
  result.writeUInt32LE(16000, 24)
  result.writeUInt32LE(32000, 28)
  result.writeUInt16LE(2, 32)
  result.writeUInt16LE(16, 34)
  result.write('data', 36)
  result.writeUInt32LE(32000, 40)
  return result
}
export function syntheticWord(): Buffer {
  return Buffer.from(
    zipSync({
      'word/document.xml': Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic policy: verify the source and authorization.</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--wav') process.stdout.write(silentWav())
  else if (args.length === 1 && args[0] === '--word') process.stdout.write(syntheticWord())
  else {
    assert(
      args.length === 3 && args[0] === '--live' && args[1] === '--output',
      400,
      'Use --wav, --word, or --live --output <path>',
    )
    const file = resolve(args[2]),
      chunks: Buffer[] = []
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    // Reserve the output before invoking a paid provider; never replace an existing fixture.
    const output = await open(file, 'wx', 0o600)
    let completed = false
    try {
      await synthesize(
        settings(),
        '您好，我想先了解您今天更关注什么问题，再核对原始资料的适用范围，不作个体效果保证。',
        'local-e2e-synthetic',
        async (pcm) => {
          chunks.push(pcm)
        },
        '',
      )
      const pcm = resample(Buffer.concat(chunks))
      assert(pcm.length > 32000, 502, 'No usable synthetic speech returned')
      await output.writeFile(pcm)
      await output.sync()
      completed = true
    } finally {
      await output.close()
      if (!completed) await unlink(file)
    }
  }
}
