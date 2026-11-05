import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resample, silentWav, syntheticWord } from '../src/e2e-assets.ts'
import { parseDocument } from '../src/documents.ts'

test('TypeScript speech and Word fixtures retain their actual media and document formats', async () => {
  const input = Buffer.alloc(12)
  ;[0, 10, 20, 30, 40, 50].forEach((v, i) => input.writeInt16LE(v, i * 2))
  const result = resample(input)
  assert.deepEqual(
    Array.from({ length: result.length / 2 }, (_, i) => result.readInt16LE(i * 2)),
    [0, 15, 30, 45],
  )
  assert.throws(() => resample(Buffer.alloc(3)))
  const wav = silentWav()
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt32LE(40), 32000)
  assert((await parseDocument(syntheticWord(), 'docx')).text.includes('Synthetic policy'))
})
