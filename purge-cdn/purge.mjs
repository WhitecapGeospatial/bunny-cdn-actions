#!/usr/bin/env node
/**
 * Purge Bunny CDN URLs for stable shell paths (not hashed bundles).
 *
 * Usage:
 *   node purge.mjs --self-check
 *   node purge.mjs --app-url <https://host> --paths-file <file> [--hashed-dir <dir>] [--dry-run]
 *
 * Env: BUNNY_CDN_API_KEY (unless --dry-run)
 *
 * Paths file = one path per line (`#` comments ok). Wildcards like `images/*` are allowed.
 * Paths that are URLs, or that reach into --hashed-dir (e.g. `assets/*`, `*`), are
 * rejected: purging them would evict every content-hashed bundle from every edge.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function parseArgs(argv) {
  const out = { selfCheck: false, dryRun: false, appUrl: '', pathsFile: '', hashedDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--app-url') {
      out.appUrl = argv[++i] || ''
      if (!out.appUrl) throw new Error('--app-url needs a value')
    } else if (a === '--paths-file') {
      out.pathsFile = argv[++i] || ''
      if (!out.pathsFile) throw new Error('--paths-file needs a path')
    } else if (a === '--hashed-dir') {
      out.hashedDir = argv[++i] || ''
      if (!out.hashedDir) throw new Error('--hashed-dir needs a value')
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected arg: ${a}`)
    }
  }
  return out
}

function parsePaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

function purgeUrl(appUrl, path) {
  const base = appUrl.replace(/\/$/, '')
  const rel = path.replace(/^\//, '')
  return `${base}/${rel}`
}

/** Same "hashed" rule as upload-storage, plus wildcards whose prefix covers the dir. */
function hitsHashedDir(path, hashedDir) {
  const dir = `${hashedDir.replace(/^\/+|\/+$/g, '')}/`
  const rel = path.replace(/^\/+/, '')
  if (rel === dir.slice(0, -1) || rel.startsWith(dir) || rel.includes(`/${dir}`)) return true
  return rel.endsWith('*') && dir.startsWith(rel.slice(0, -1))
}

function validatePaths(paths, hashedDir) {
  for (const path of paths) {
    if (/^https?:\/\//i.test(path)) {
      throw new Error(`purge paths must be paths relative to app-url, not URLs: ${path}`)
    }
    if (hashedDir && hitsHashedDir(path, hashedDir)) {
      throw new Error(
        `refusing to purge ${path}: it covers hashed dir ${hashedDir}/ (would evict every bundle)`
      )
    }
  }
}

function selfCheck() {
  assert.equal(purgeUrl('https://example.com/', 'index.html'), 'https://example.com/index.html')
  assert.equal(purgeUrl('https://example.com', 'images/*'), 'https://example.com/images/*')
  assert.deepEqual(parsePaths('# x\nindex.html\nfonts/*\n'), ['index.html', 'fonts/*'])
  for (const p of ['assets', 'assets/*', '/assets/index-abc.js', '*', '/*', 'as*', 'pr-1/assets/x.js']) {
    assert.equal(hitsHashedDir(p, 'assets'), true, p)
  }
  for (const p of ['index.html', '/', 'images/*', 'assets.json', 'b*', 'manifest.json']) {
    assert.equal(hitsHashedDir(p, 'assets/'), false, p)
  }
  assert.throws(() => validatePaths(['https://x.com/a'], ''), /not URLs/)
  assert.throws(() => validatePaths(['index.html', 'static/*'], 'static'), /refusing/)
  validatePaths(['index.html', 'images/*'], 'static')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: purge.mjs self-check')
    return
  }

  if (!args.appUrl || !args.pathsFile) {
    throw new Error('usage: node purge.mjs --app-url <url> --paths-file <path> [--hashed-dir <dir>] [--dry-run]')
  }

  const apiKey = process.env.BUNNY_CDN_API_KEY?.trim()
  if (!args.dryRun && !apiKey) throw new Error('missing BUNNY_CDN_API_KEY')

  const paths = parsePaths(await readFile(args.pathsFile, 'utf8'))
  if (paths.length === 0) throw new Error(`empty paths file: ${args.pathsFile}`)
  validatePaths(paths, args.hashedDir)

  for (const path of paths) {
    const url = purgeUrl(args.appUrl, path)
    if (args.dryRun) {
      console.log(`dry-run purge ${url}`)
      continue
    }
    const res = await fetch(
      `https://api.bunny.net/purge?${new URLSearchParams({ url, async: 'false' })}`,
      {
        method: 'POST',
        headers: { AccessKey: apiKey },
      }
    )
    if (!res.ok) {
      throw new Error(`purge ${url} -> ${res.status} ${await res.text()}`)
    }
    console.log(`purged ${url}`)
  }

  console.log(`OK: ${paths.length} paths purged.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
