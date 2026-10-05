# bunny-cdn-actions

Shared GitHub Actions for Bunny Storage upload, CDN purge, and Nautilus → Bunny geodata sync.

Mechanism only — each app keeps its own `src/cdnAssets.ts` inventory and thin caller workflows.

## Layout

```
bunny-cdn-actions/
  .github/workflows/
    ci.yml              # --self-check on every script (no live Nautilus/Bunny)
    sync-geodata.yml    # reusable workflow (workflow_call)
  lib/extract-export.mjs  # shared: esbuild an app's catalog module, dump one export
  sync-geodata/         # composite: extract + rclone install + copy/check + optional verify
  upload-storage/       # composite: PUT build dir (hashed first)
  purge-cdn/            # composite: extract + purge stable shell paths
```

Plain Node `.mjs` scripts. No `package.json`, no TypeScript in this repo.

## Org access

This repo is public so callers in any org can `uses:` it. It lives in `WhitecapGeospatial` (moved from `UCSCGeospatialVisualizationLab`, which GitHub still redirects). Pin callers at `@v1`.

## Required secrets / vars (on the caller)

| Name | Kind | Used by |
|------|------|---------|
| `NAUTILUS_GEODATA_ACCESS_KEY_ID` | secret | sync |
| `NAUTILUS_GEODATA_SECRET_ACCESS_KEY` | secret | sync |
| `BUNNY_STORAGE_ZONE` | secret | sync, upload |
| `BUNNY_STORAGE_PASSWORD` | secret | sync, upload |
| `BUNNY_CDN_API_KEY` | secret | purge |
| `BUNNY_STORAGE_HOST` | var | sync, upload (e.g. `ny.storage.bunnycdn.com`) |
| `APP_URL` | var | sync verify + purge (e.g. `https://app.example.com`) |
| `NAUTILUS_S3_HOST` | var | optional; default `s3-west.nrp-nautilus.io` |

Environments: reusable sync uses `preview` on pull_request, `production` otherwise. Callers should define the same env secrets/vars nbs uses.

## `cdnAssets` contract (in each app)

Path: `src/cdnAssets.ts` — leaf module (do not import the rest of `constants.ts` / CRA `process.env` graphs).

- `CDN_ASSET_S3_OBJECTS`: `bucket/key` strings only, never `https://` URLs
- Trailing slash = prefix copy (e.g. sedero COG folder)
- `.m3u8` entries copy the parent prefix (HLS segments)
- `cacheEntrypoints`: stable shell paths for production purge — never under the hashed dir (`assets/*`, `*`), which would evict every bundle
- Module must esbuild for Node: `--bundle --platform=node --format=esm --packages=external`

## Sync caller

Path filters stay in the caller.

```yaml
# .github/workflows/sync-geodata.yml
name: Sync geodata to Bunny Storage
on:
  push:
    branches: [main]
    paths: [src/cdnAssets.ts, src/constants.ts, .github/workflows/sync-geodata.yml]
  pull_request:
    paths: [src/cdnAssets.ts, src/constants.ts, .github/workflows/sync-geodata.yml]
  workflow_dispatch:
jobs:
  sync:
    uses: WhitecapGeospatial/bunny-cdn-actions/.github/workflows/sync-geodata.yml@v1
    secrets: inherit
```

Inputs (all optional except what you need):

| Input | Default | Notes |
|-------|---------|-------|
| `catalog-module` | `src/cdnAssets.ts` | Leaf module to esbuild |
| `catalog-export` | `CDN_ASSET_S3_OBJECTS` | Named export |
| `catalog-file` | _(empty)_ | Debug override — skips extract; not a migration path |
| `cdn-host` | `vars.APP_URL` | Smoke host for verify; falls back to `APP_URL` as seen by the shared job, which has the `preview`/`production` environment (the caller's job doesn't) |
| `verify` | `true` | Ignored on pull_request |
| `dry-run` | `false` | rclone dry-run |

Behavior:

- **PR:** `--check-source-only` (objects exist on Nautilus)
- **push / workflow_dispatch:** copy, then verify when `verify: true`
- Timeout 360 minutes

### Catalog extract (`lib/extract-export.mjs`)

Both `sync-geodata` and `purge-cdn` run it against the caller checkout:

1. `npx esbuild@<pinned>` bundles `catalog-module` (secrets stripped from npx's env)
2. Imports `catalog-export`, checks it is a non-empty array of non-empty, non-URL strings
3. Writes one entry per line → catalog for `copy.mjs` / `verify.mjs`, or paths for `purge.mjs`

The list stays app-owned; only the code that reads it lives here.

## Deploy / upload / purge caller

```yaml
- uses: WhitecapGeospatial/bunny-cdn-actions/upload-storage@v1
  with:
    build-dir: dist          # CRA: build
    hashed-dir: assets       # CRA: static
    remote-prefix: ${{ env.DEPLOY_ENV != 'production' && env.DEPLOY_PATH || '' }}
  env:
    BUNNY_STORAGE_ZONE: ${{ secrets.BUNNY_STORAGE_ZONE }}
    BUNNY_STORAGE_PASSWORD: ${{ secrets.BUNNY_STORAGE_PASSWORD }}
    BUNNY_STORAGE_HOST: ${{ vars.BUNNY_STORAGE_HOST }}

- uses: WhitecapGeospatial/bunny-cdn-actions/purge-cdn@v1
  if: env.DEPLOY_ENV == 'production'
  with:
    app-url: ${{ vars.APP_URL }}
    hashed-dir: assets       # CRA: static (default: assets)
  env:
    BUNNY_CDN_API_KEY: ${{ secrets.BUNNY_CDN_API_KEY }}
```

`purge-cdn` inputs:

| Input | Default | Notes |
|-------|---------|-------|
| `app-url` | _(required)_ | Origin the paths are relative to |
| `catalog-module` | `src/cdnAssets.ts` | Leaf module to esbuild |
| `catalog-export` | `cacheEntrypoints` | Named export |
| `paths-file` | _(empty)_ | Override for apps without such a module — skips extract |
| `hashed-dir` | `assets` | Paths covering it (`assets/*`, `*`, `as*`) fail the step; match `upload-storage` |
| `dry-run` | `false` | Log purge URLs only |

The `cacheEntrypoints` list stays in the app; the action only reads it. Dual-write to Nautilus stays in the app deploy workflow.

## Verify rules

URLs are `${cdn-host}/${s3-path}`. Extension-based checks:

- `.pmtiles` — magic bytes
- `.m3u8` — playlist + segment fetch
- `.json` / `.gpkg` — HTTP 200/206 and not HTML
- else — TIFF/COG magic bytes

Trailing-slash catalog entries are skipped at verify (prefix copy only).

## Local self-check

```bash
node lib/extract-export.mjs --self-check
node sync-geodata/copy.mjs --self-check
node sync-geodata/verify.mjs --self-check
node upload-storage/upload.mjs --self-check
node purge-cdn/purge.mjs --self-check
```
