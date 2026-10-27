import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import { vercelFileSha, type VercelSourceFile } from './vercel_api_client.js'

const maximumFiles = 15_000
const maximumExpandedBytes = 100 * 1024 * 1024

export async function validateDeploymentSource(
  content: Uint8Array,
  expected: { sha256: string; size: number }
): Promise<VercelSourceFile[]> {
  if (content.byteLength !== expected.size) throw new Error('Deployment source size mismatch')
  const digest = createHash('sha256').update(content).digest('hex')
  if (digest !== expected.sha256) throw new Error('Deployment source checksum mismatch')
  const parser = extract()
  const files: VercelSourceFile[] = []
  const caseInsensitivePaths = new Set<string>()
  let expandedBytes = 0
  const completion = new Promise<void>((resolve, reject) => {
    parser.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      let received = 0
      let rejected = false
      const declaredSize = header.size ?? 0
      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > maximumExpandedBytes - expandedBytes
      ) {
        rejected = true
        stream.resume()
        parser.destroy(new Error('Deployment source expands beyond its limit'))
        return
      }
      stream.on('data', (chunk) => {
        if (rejected) return
        if (!Buffer.isBuffer(chunk)) {
          rejected = true
          parser.destroy(new Error('Deployment source contains non-binary data'))
          return
        }
        received += chunk.length
        if (received > maximumExpandedBytes - expandedBytes) {
          rejected = true
          parser.destroy(new Error('Deployment source expands beyond its limit'))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      stream.on('error', reject)
      stream.on('end', () => {
        if (rejected) return
        try {
          const path = safeArchivePath(header.name)
          if (header.type === 'directory') {
            next()
            return
          }
          if ((header.type ?? 'file') !== 'file') {
            throw new Error('Deployment source contains an unsupported link or device')
          }
          assertAllowedPath(path)
          const collisionKey = path.toLocaleLowerCase('en-US')
          if (caseInsensitivePaths.has(collisionKey)) {
            throw new Error('Deployment source contains a case-insensitive path collision')
          }
          caseInsensitivePaths.add(collisionKey)
          if (files.length >= maximumFiles) {
            throw new Error('Deployment source contains too many files')
          }
          if (received !== declaredSize) throw new Error('Deployment source file size mismatch')
          expandedBytes += received
          if (expandedBytes > maximumExpandedBytes) {
            throw new Error('Deployment source expands beyond its limit')
          }
          const fileContent = Buffer.concat(chunks)
          if (highConfidenceSecret(fileContent)) {
            throw new Error('Deployment source contains a high-confidence secret')
          }
          files.push({
            content: fileContent,
            file: path,
            mode: header.mode && header.mode & 0o111 ? 0o755 : 0o644,
            sha: vercelFileSha(fileContent),
            size: fileContent.byteLength,
          })
          next()
        } catch (error) {
          reject(error)
        }
      })
    })
    parser.once('finish', resolve)
    parser.once('error', reject)
  })
  const source = Readable.from(Buffer.from(content))
  if (gzip(content)) source.pipe(createGunzip()).pipe(parser)
  else source.pipe(parser)
  await completion
  if (!files.length) throw new Error('Deployment source is empty')
  return files.sort((left, right) => left.file.localeCompare(right.file))
}

function safeArchivePath(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Deployment source contains path traversal')
  }
  return normalized
}

function assertAllowedPath(path: string) {
  const segments = path.toLowerCase().split('/')
  const basename = segments.at(-1) ?? ''
  if (
    segments.some((segment) =>
      [
        '.git',
        '.ssh',
        '.blame',
        '.vercel',
        'node_modules',
        '.pnpm-store',
        '.yarn',
        '.turbo',
        '.cache',
      ].includes(segment)
    ) ||
    basename === '.env' ||
    (basename.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(basename)) ||
    [
      '.npmrc',
      '.pypirc',
      'id_rsa',
      'id_ed25519',
      'credentials',
      'credentials.json',
      'service-account.json',
    ].includes(basename) ||
    /(?:^|\.)private[-_.]?key(?:\.|$)/.test(basename) ||
    /\.(?:pem|p12|pfx|key|log|sock)$/.test(basename)
  ) {
    throw new Error('Deployment source contains a forbidden path')
  }
}

function highConfidenceSecret(content: Buffer) {
  if (content.byteLength > 1024 * 1024 || content.includes(0)) return false
  const text = content.toString('utf8')
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
    /\bsk_live_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  ].some((pattern) => pattern.test(text))
}

function gzip(content: Uint8Array) {
  return content[0] === 0x1f && content[1] === 0x8b
}
