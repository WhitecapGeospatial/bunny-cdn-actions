#!/usr/bin/env node
/**
 * Bundle an app's leaf catalog module with esbuild and write one named
 * string-array export to a file, one entry per line.
 *
 * Shared by sync-geodata (CDN_ASSET_S3_OBJECTS) and purge-cdn (cacheEntrypoints).
 *
 * Usage:
 *   node extract-export.mjs --self-check
 *   node extract-export.mjs --module src/cdnAssets.ts --export <name> --out <file>
 *
 * Checks: export is an array of non-empty strings, none of them URLs.
 * Callers add their own rules on top (purge.mjs rejects hashed-dir paths).
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Pinned: this runs in jobs that hold deploy secrets. Bump deliberately.
const ESBUILD_VERSION = '0.28.2'

function parseArgs(argv) {
  const out = { selfCheck: false, module: '', exportName: '', out: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--module') {
      out.module = argv[++i] || ''
      if (!out.module) throw new Error('--module needs a path')
    } else if (a === '--export') {
      out.exportName = argv[++i] || ''
      if (!out.exportName) throw new Error('--export needs a name')
    } else if (a === '--out') {
      out.out = argv[++i] || ''
      if (!out.out) throw new Error('--out needs a path')
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected arg: ${a}`)
    }
  }
  return out
}

function validateEntries(name, value) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings (got ${typeof value})`)
  }
  for (const p of value) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new Error(`${name}: entry must be a non-empty string: ${JSON.stringify(p)}`)
    }
    if (/^https?:\/\//i.test(p.trim())) {
      throw new Error(`${name}: entries must be paths, not URLs: ${p}`)
    }
  }
  return value.map((p) => p.trim())
}

function selfCheck() {
  assert.deepEqual(validateEntries('x', [' a/b.pmtiles ', 'index.html']), ['a/b.pmtiles', 'index.html'])
  assert.deepEqual(validateEntries('x', []), [])
  assert.throws(() => validateEntries('x', 'index.html'), /must be an array/)
  assert.throws(() => validateEntries('x', ['ok', '']), /non-empty string/)
  assert.throws(() => validateEntries('x', [42]), /non-empty string/)
  assert.throws(() => validateEntries('x', ['https://cdn.example.com/a']), /not URLs/)
  assert.throws(() => validateEntries('x', ['HTTP://cdn.example.com/a']), /not URLs/)
}

async function bundle(modulePath, outFile) {
  // npx installs esbuild (which has an install script); keep secrets out of its env.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  await execFileAsync(
    'npx',
    [
      '--yes',
      `esbuild@${ESBUILD_VERSION}`,
      modulePath,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      '--log-level=warning',
      `--outfile=${outFile}`,
    ],
    { env, maxBuffer: 8 * 1024 * 1024 }
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: extract-export.mjs self-check')
    return
  }

  if (!args.module || !args.exportName || !args.out) {
    throw new Error('usage: node extract-export.mjs --module <path> --export <name> --out <file>')
  }

  const dir = await mkdtemp(join(tmpdir(), 'extract-export-'))
  try {
    const bundled = join(dir, 'module.mjs')
    await bundle(resolve(args.module), bundled)
    const mod = await import(pathToFileURL(bundled).href)
    if (!(args.exportName in mod)) {
      throw new Error(`${args.module} has no export named ${args.exportName}`)
    }
    const entries = validateEntries(args.exportName, mod[args.exportName])
    if (entries.length === 0) throw new Error(`${args.exportName} is empty in ${args.module}`)
    await writeFile(args.out, entries.map((p) => `${p}\n`).join(''))
    console.log(`Extracted ${entries.length} ${args.exportName} entries from ${args.module}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
