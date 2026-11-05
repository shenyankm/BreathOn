import { randomBytes, scrypt } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16),
    digest = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        32,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    )
  return `scrypt:${salt.toString('hex')}:${digest.toString('hex')}`
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY) throw new Error('Run password generation in an interactive terminal')
  process.stdout.write('Password (at least 12 characters, hidden): ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let password = ''
  try {
    password = await new Promise<string>((resolve, reject) => {
      let text = ''
      process.stdin.on('data', (chunk) => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') {
            resolve(text)
            return
          }
          if (char === '\u0003') {
            reject(new Error('Cancelled'))
            return
          }
          if (char === '\u007f') text = text.slice(0, -1)
          else if (char >= ' ' && text.length < 512) text += char
        }
      })
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write('\n')
  }
  if (password.length < 12) throw new Error('Use at least 12 characters')
  console.log(await hashPassword(password))
}
