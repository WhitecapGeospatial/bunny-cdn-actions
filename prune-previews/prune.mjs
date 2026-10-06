#!/usr/bin/env node
/**
 * Delete preview builds from Bunny Storage once their PR has been closed for N days.
 *
 * Usage:
 *   node prune.mjs --self-check
 *   node prune.mjs --prefix-pattern <pr-{n}> --closed-days <30> --app-url <https://host> [--dry-run]
 *
 * Env: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST, BUNNY_STORAGE_PASSWORD (listing needs it, even dry-run)
 *      GITHUB_TOKEN, GITHUB_REPOSITORY
 *      BUNNY_CDN_API_KEY (unless --dry-run)
 *
 * Only top-level storage folders whose whole name matches --prefix-pattern are considered;
 * `{n}` is the PR number. Everything else (production files at the root) is never touched.
 * A matching folder is purged from the CDN and then deleted when its PR is closed (merged
 * or not) and closed_at is more than --closed-days ago. Open, reopened, or unknown PRs are kept.
 */
import assert from 'node:assert/strict'

const DAY_MS = 24 * 60 * 60 * 1000

function parseArgs(argv) {
  const out = { selfCheck: false, dryRun: false, prefixPattern: '', closedDays: '', appUrl: '' }
  const valued = { '--prefix-pattern': 'prefixPattern', '--closed-days': 'closedDays', '--app-url': 'appUrl' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a in valued) {
      out[valued[a]] = argv[++i] || ''
      if (!out[valued[a]]) throw new Error(`${a} needs a value`)
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected arg: ${a}`)
    }
  }
  return out
}

/** `pr-{n}` -> /^pr\-(\d+)$/. Exactly one `{n}`, at least one literal char, no slashes. */
function compilePattern(pattern) {
  const parts = pattern.split('{n}')
  if (parts.length !== 2) throw new Error(`prefix-pattern must contain exactly one {n}: ${pattern}`)
  if (!parts.join('')) throw new Error(`prefix-pattern needs literal text around {n}: ${pattern}`)
  if (/[/\\*{}]/.test(parts.join(''))) {
    throw new Error(`prefix-pattern must be a single folder name (no / \\ * { }): ${pattern}`)
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return new RegExp(`^${esc(parts[0])}(\\d+)${esc(parts[1])}$`)
}

function parseClosedDays(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`closed-days must be a whole number >= 1: ${value}`)
  }
  return Number(value)
}

/** Pure decision for one folder. `pr` is the GitHub API response, or null on 404. */
function decide(pr, closedDays, now) {
  if (!pr) return { prune: false, reason: 'no such PR' }
  if (pr.state !== 'closed' || !pr.closed_at) return { prune: false, reason: `PR is ${pr.state}` }
  const ageDays = (now - Date.parse(pr.closed_at)) / DAY_MS
  const how = pr.merged_at ? 'merged' : 'closed'
  if (ageDays <= closedDays) {
    return { prune: false, reason: `${how} ${Math.floor(ageDays)}d ago (keep until ${closedDays}d)` }
  }
  return { prune: true, reason: `${how} ${Math.floor(ageDays)}d ago` }
}

function storageUrl(host, zone, folder) {
  return `https://${host}/${encodeURIComponent(zone)}/${folder ? `${encodeURIComponent(folder)}/` : ''}`
}

function purgeUrl(appUrl, folder) {
  return `${appUrl.replace(/\/$/, '')}/${folder}/*`
}

function selfCheck() {
  const re = compilePattern('pr-{n}')
  assert.deepEqual('pr-12'.match(re)?.[1], '12')
  for (const name of ['pr-', 'pr-12x', 'xpr-12', 'pr-1/assets', 'assets', 'index.html', '12']) {
    assert.equal(re.test(name), false, name)
  }
  assert.equal(compilePattern('preview.{n}.build').test('preview.7.build'), true)
  assert.equal(compilePattern('preview.{n}.build').test('previewX7Xbuild'), false)
  assert.throws(() => compilePattern('{n}'), /literal/)
  assert.throws(() => compilePattern('pr'), /exactly one/)
  assert.throws(() => compilePattern('pr-{n}-{n}'), /exactly one/)
  assert.throws(() => compilePattern('previews/pr-{n}'), /single folder/)
  assert.throws(() => compilePattern('pr-*{n}'), /single folder/)

  assert.equal(parseClosedDays('30'), 30)
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => parseClosedDays(bad), /whole number/)

  const now = Date.parse('2026-10-05T00:00:00Z')
  const closed = (daysAgo, merged = true) => {
    const at = new Date(now - daysAgo * DAY_MS).toISOString()
    return { state: 'closed', closed_at: at, merged_at: merged ? at : null }
  }
  assert.equal(decide(null, 30, now).prune, false)
  assert.equal(decide({ state: 'open', closed_at: null }, 30, now).prune, false)
  assert.equal(decide(closed(30), 30, now).prune, false)
  assert.equal(decide(closed(31), 30, now).prune, true)
  assert.match(decide(closed(31, false), 30, now).reason, /^closed/)
  assert.match(decide(closed(31), 30, now).reason, /^merged/)

  assert.equal(storageUrl('ny.storage.bunnycdn.com', 'zone', ''), 'https://ny.storage.bunnycdn.com/zone/')
  assert.equal(storageUrl('ny.storage.bunnycdn.com', 'zone', 'pr-1'), 'https://ny.storage.bunnycdn.com/zone/pr-1/')
  assert.equal(purgeUrl('https://example.com/', 'pr-1'), 'https://example.com/pr-1/*')
}

async function check(res, what) {
  if (!res.ok) throw new Error(`${what} -> ${res.status} ${await res.text()}`)
  return res
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: prune.mjs self-check')
    return
  }

  if (!args.prefixPattern || !args.closedDays || !args.appUrl) {
    throw new Error(
      'usage: node prune.mjs --prefix-pattern <pr-{n}> --closed-days <n> --app-url <url> [--dry-run]'
    )
  }
  const pattern = compilePattern(args.prefixPattern)
  const closedDays = parseClosedDays(args.closedDays)

  const env = (name) => process.env[name]?.trim() || ''
  const zone = env('BUNNY_STORAGE_ZONE')
  const host = env('BUNNY_STORAGE_HOST')
  const storageKey = env('BUNNY_STORAGE_PASSWORD')
  const cdnKey = env('BUNNY_CDN_API_KEY')
  const token = env('GITHUB_TOKEN')
  const repo = env('GITHUB_REPOSITORY')
  const missing = Object.entries({
    BUNNY_STORAGE_ZONE: zone,
    BUNNY_STORAGE_HOST: host,
    BUNNY_STORAGE_PASSWORD: storageKey,
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: repo,
    ...(args.dryRun ? {} : { BUNNY_CDN_API_KEY: cdnKey }),
  })
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`)

  const listing = await (
    await check(await fetch(storageUrl(host, zone, ''), { headers: { AccessKey: storageKey } }), 'list storage root')
  ).json()
  const folders = listing
    .filter((o) => o.IsDirectory)
    .map((o) => ({ name: o.ObjectName, match: o.ObjectName.match(pattern) }))
    .filter((f) => f.match)
  console.log(`${folders.length} folders match ${args.prefixPattern} (of ${listing.length} root entries)`)

  const now = Date.now()
  let pruned = 0
  const failures = []
  for (const { name, match } of folders) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${match[1]}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      const pr = res.status === 404 ? null : await (await check(res, `GET PR #${match[1]}`)).json()
      const { prune, reason } = decide(pr, closedDays, now)
      if (!prune) {
        console.log(`keep   ${name}: ${reason}`)
        continue
      }
      if (args.dryRun) {
        console.log(`dry-run prune ${name}: ${reason}`)
        pruned++
        continue
      }
      // Purge first: if the delete then fails, the folder is still there and the next run retries both.
      const url = purgeUrl(args.appUrl, name)
      await check(
        await fetch(`https://api.bunny.net/purge?${new URLSearchParams({ url, async: 'false' })}`, {
          method: 'POST',
          headers: { AccessKey: cdnKey },
        }),
        `purge ${url}`
      )
      await check(
        await fetch(storageUrl(host, zone, name), { method: 'DELETE', headers: { AccessKey: storageKey } }),
        `DELETE ${name}/`
      )
      console.log(`pruned ${name}: ${reason}`)
      pruned++
    } catch (err) {
      console.error(`FAIL   ${name}: ${err.message}`)
      failures.push(name)
    }
  }

  const verb = args.dryRun ? 'would prune' : 'pruned'
  console.log(`${verb} ${pruned}, kept ${folders.length - pruned - failures.length}, failed ${failures.length}`)
  if (failures.length) throw new Error(`failed to prune: ${failures.join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
