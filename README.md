# fix-9r

Companion CLI + tiny dashboard that **patches** [9router](https://github.com/decolua/9router) and **manages your Gemini API key pool** at scale.

| | |
|---|---|
| Patches | gc/genlang routing · gc credentials · AG image generation (incl. v0.4.18+ plugin) |
| Pool ops | bulk discover existing keys · bulk create new projects+keys · live parallel health check (~0.5s/56 keys) · auto-cleanup dead projects |
| Failure handling | per-account 24h cooldown after 3 dead-keys / quota cap / Google flag |
| UI | dashboard at `:20129` with cards, per-OAuth breakdown, live actions |
| Daemon | `fix-9r cron install` → daily auto-prune at 03:15 |

```
┌─ fix-9r ───────────────────────────────────────────────────────────┐
│                                                                    │
│  patch    │ status   │ prune     │ discover  │ expand   │ ui       │
│  update   │ install  │ install-9router │ restart-9router │ cron    │
│  menu     │ help                                                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Quickstart

**One-time setup** (any machine — Mac, Linux, VPS, Docker):

```bash
# Run + globally install in a single step
npx -y dmdfami/fix-9router install
```

**From now on** — just type one of:

```bash
fix-9r              # interactive numbered menu
fix-9r ui           # web dashboard at http://localhost:20129
fix-9r status       # quick pool overview
fix-9r --help       # full reference
```

That's it. The patcher auto-detects 9router across Homebrew, npm/pnpm/yarn globals, nvm/asdf/Volta/fnm, snap, Docker, and source checkouts.

> **No 9router yet?** `fix-9r install-9router` runs `npm i -g 9router` for you.

> **VPS over SSH:** `ssh root@your.vps 'npx -y dmdfami/fix-9router install && fix-9r patch && fix-9r restart-9router'`

---

## Why fix-9r

You probably ended up here because you self-host 9router with **multiple Google accounts** and **dozens of API keys**. At that scale 9router's built-in UI hits limits:

- a Gemini API project Google has flagged keeps rotating in the pool, returning 403, and needs to be deleted by hand;
- adding a new project + API key per OAuth account requires three Google Cloud APIs and Operation polling;
- after every `npm i -g 9router@latest` you re-run two patches by hand;
- `gemini-2.5-pro` is rejected on free Google accounts unless routed through `gen-lang-client-*` projects;
- AG image generation `/v1/images/generations` doesn't ship with 9router.

`fix-9r` makes the loop "create → test → adopt → prune" a one-liner, and ships patches that survive 9router's release cadence.

---

## Subcommands

| Command | What it does |
|---|---|
| `fix-9r` (no args, in TTY) | Interactive numbered menu |
| `fix-9r patch` *(default)* | Apply 9router patches; idempotent |
| `fix-9r status` | Pool overview table per provider |
| `fix-9r prune [--disable\|--delete]` | Live-test active gemini keys, optionally disable/delete Unavailable |
| `fix-9r discover [--delete-permission-denied]` | Scan every gemini-cli OAuth, list every Cloud project + its keys, create keys on empty owned projects, test, adopt Free, optionally delete permission-denied projects |
| `fix-9r expand [target] [limit]` | Auto-create projects + keys per OAuth account in parallel; auto-cleans dead projects; per-account 24h cooldown on quota/flag/3xfail |
| `fix-9r update` | `npm i -g 9router@latest` + re-apply patches + restart 9router |
| `fix-9r install-9router` | `npm i -g 9router` (use on a fresh box) |
| `fix-9r restart-9router` | Kill + respawn 9router (pm2/systemctl/fallback) |
| `fix-9r cron [show\|install\|uninstall]` | Manage daily cron entry (default 03:15 → `prune --delete`) |
| `fix-9r ui` / `fix-9r web` | Local web dashboard at `:20129` |
| `fix-9r install` | npm i -g this repo so `fix-9r` is on PATH |

---

## Patches

| Patch | What it adds | Status on v0.4.18+ |
|---|---|---|
| **gc/genlang executor** | Models prefixed `genlang/` route through `credentials.genLangProject` instead of `duetProject`. Unlocks `gemini-2.5-pro` on free Google accounts. | ✅ source + packaged |
| **gc credentials passthrough** | `getProviderCredentials` exposes `duetProject` + `genLangProject` to the executor (without this, the genlang route silently falls back to duet). | ✅ source + packaged |
| **AG image model** | Adds `gemini-3.1-flash-image` to `PROVIDER_MODELS.ag`. | ✅ source + packaged |
| **AG image plugin** | Routes `model: "ag/gemini-3.1-flash-image"` on `/v1/images/generations` through Antigravity OAuth. Source-checkout writes `imageProviders/antigravity.js`; packaged build injects an IIFE adapter into the minified ADAPTERS map. | ✅ source + packaged |

Each patch:
- Idempotent — markers detect "already patched"
- Independent — one failure does not stop the others
- Backed up — every modified file gets a `.bak-<timestamp>` sibling
- Future-aware — patches that target obsolete files surface as `obsolete (v0.4.18+)`, not red `not yet`

After patching, run `fix-9r restart-9router` so the new bundle is served.

---

## Dashboard

```
fix-9r ui              # opens http://localhost:20129 in your browser
```

| Section | What you get |
|---|---|
| Header | Running 9router version + npm latest + `Restart 9router` / `Install 9router` button |
| Pool overview | Cards per provider (Gemini, AG, GC, Codex, GitHub) with active count |
| Patches | Inline status row (applied / not yet / obsolete / n/a) for each of the 4 patches |
| Gemini key pool | Per-OAuth-account collapsible table: Cloud projects · Adopted keys · Health badges (Free/Quota/Bad). Click a row to expand and Test/Remove individual keys |
| Buttons | 🩺 Test all (live, parallel ~0.5s) · 🔍 Discover · ➕ Bulk expand · 🗑 Delete dead (with cascade-Cloud-delete option) |
| Recent activity | Last 50 commands with timestamps, model used, account email, project ID |

All destructive actions go through a confirm dialog with explicit description of what will mutate. Subprocess output streams to a bottom-right log panel — no 60-second freeze.

---

## Common workflows

### "Fresh machine, no 9router yet"

```bash
npx -y dmdfami/fix-9router install     # globally install fix-9r
fix-9r install-9router                 # globally install 9router
fix-9r patch                           # apply patches
fix-9r restart-9router                 # so 9router serves new bundle
fix-9r ui                              # configure pool in dashboard
```

### "Grow the Gemini key pool"

```bash
fix-9r discover                        # adopt anything you already created in AI Studio
fix-9r expand 30 5                     # top up to 30 projects per OAuth, 5 new per run
fix-9r prune                           # health-check the result (read-only)
```

The dashboard's **🔍 Discover** dialog also offers `--delete-permission-denied` to recover Google's 30-project quota slot from suspended `genai-*` projects.

### "Daily auto-clean"

```bash
fix-9r cron install                    # 03:15 daily → prune --delete
fix-9r cron show                       # confirm
```

Logs to `~/.9router/fix-9r-cron.log`.

### "9router shipped a new version"

```bash
fix-9r update                          # = npm i -g 9router@latest && patch && restart
```

### "Test AG image generation"

```bash
curl -sS http://localhost:20128/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"ag/gemini-3.1-flash-image","prompt":"a small red teapot on a white table"}' \
  -o teapot.json
# → HTTP 200, ~16s, JPEG b64 in data[0].b64_json
```

### "Test gc/genlang routing"

```bash
# Add the model in the 9router UI first (Add Model on Gemini CLI provider):
#   genlang/gemini-2.5-pro
curl -sS http://localhost:20128/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gc/genlang/gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}'
```

---

## Health-check semantics

`fix-9r` classifies each Gemini API key with a single `GET /v1beta/models/<model>?key=<KEY>` (no quota consumption, no rate-limit, ~50ms each). 56 keys parallel completes in ~500ms.

| HTTP | AI Studio billing tier | UI badge |
|---|---|---|
| 200 | Free tier | green `Free` |
| 429 | Free tier (daily quota cap) | yellow `Quota` (auto-recovers tomorrow) |
| 403 | Unavailable (project/key suspended) | red `Bad` |
| other | unknown | grey `?` |

`prune --delete` removes only the `Unavailable` rows. `prune --delete --cascade` (via UI) also DELETEs the underlying Cloud project so it stops eating your 30-project quota.

---

## Failure-handling: per-account 24h cooldown

`expand` writes `expandCooldownUntil` on the OAuth row when:

- `createProject` fails with `429` / `quota` (account at Google's 30-project ceiling)
- `createProject` fails with `403` / `denied` / `suspended` (account flagged)
- 3 consecutive newly-created keys fail health-test (account producing dead keys)

Subsequent `expand` calls skip the account with:
```
⊘ <email> — in cooldown (Xh left); skip
```

Cooldown is per-account; the rest of the pool keeps creating keys.

---

## Architecture

```
~/.9router/                               9router state (db.json, logs, scripts)
   db.json                                ← fix-9r reads/writes here (atomic)
   db.json.bak.<timestamp>                ← every mutation backed up

/opt/homebrew/lib/node_modules/9router/   or your install path
   open-sse/...                           ← source patches go here
   src/...                                ← (Next.js src) source patches
   app/.next/server/...                   ← packaged-build patches here
   *.bak-<timestamp>                      ← every patch leaves a backup

dmdfami/fix-9router                       ← this repo, single file bin/fix-9router.js
```

`fix-9r` doesn't run a daemon. The `ui` subcommand is a tiny ad-hoc HTTP server that spawns `fix-9r <subcommand>` as subprocesses on demand — same code path as the CLI.

OAuth `client_id`/`client_secret` for Google Cloud Resource Manager / API Keys / Service Usage are read **at runtime** from your installed 9router source. No secrets in this repo.

---

## Compatibility

| | Tested | Notes |
|---|---|---|
| 9router ≤ v0.4.10 | ✓ | legacy AG image core patch path |
| 9router v0.4.18+ | ✓ | uses imageProviders plugin system |
| Node ≥ 18 | ✓ | required (top-level await, `node:` imports) |
| macOS / Linux | ✓ | full support |
| Windows | ✓ | path detection covers nvm-windows + AppData; UI works in cmd/PowerShell |
| Docker | ✓ | `RUN npm i -g github:dmdfami/fix-9router && fix-9r patch` in your Dockerfile |
| Snap install | ✓ | needs `sudo` |

---

## Path detection

`fix-9r patch` finds 9router automatically across:

```
which 9router → realpath → walk up to package.json   (most reliable)
npm root -g · pnpm root -g · yarn global dir         (package managers)
~/.nvm/versions/node/*/lib/node_modules              (nvm)
~/.asdf/installs/nodejs/*/lib/node_modules           (asdf)
~/.volta/tools/image/node/*/lib/node_modules         (Volta)
~/.local/share/fnm/node-versions/*/installation/lib/node_modules   (fnm)
/usr/local/n/versions/node/*/lib/node_modules        (n)
%APPDATA%\npm\node_modules\9router                   (Windows npm)
%NVM_HOME%\v*\node_modules\9router                   (nvm-windows)
/opt/homebrew/lib/node_modules/9router               (macOS Homebrew)
/usr/local/lib/node_modules/9router                  (Linux/Mac classic)
/usr/lib/node_modules/9router                        (distro npm)
/snap/9router/current                                (snap)
/app /srv/9router                                    (Docker / VPS)
~/Code/9router ~/projects/9router ~/9router cwd      (source checkout)
```

Override with `fix-9r patch --dir /actual/path`. On detection failure the error lists every path it tried.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not find 9router` | install path not in our search list | `fix-9r patch --dir /your/path` |
| Dashboard stuck at `loading…` | stale browser cache | hard-reload (Cmd+Shift+R); v0.6.6+ already sends `Cache-Control: no-cache` |
| `expand` reports `exceeded project quota` | account at Google's 30-project ceiling | `expand` auto-cools the account 24h; manually delete unused projects in Cloud Console to recover slots |
| Keys created by `expand` are `isActive=false` | auto-test failed | check the row's `lastError`; usually account-level flag, retry tomorrow |
| `prune` says everything Free but 9router still rotates dead keys | 9router process holds old db | `fix-9r restart-9router` |
| 9router web UI still shows old version after `update` | bundle cached in running process | `fix-9r restart-9router` (cmdUpdate now does this automatically since v0.5.0) |
| `AG image plugin: n/a (packaged)` on a NEW packaged install | new packaged-build injection not yet applied | `fix-9r patch` again, then `fix-9r restart-9router` |
| AG image returns "Provider 'antigravity' does not support image generation" | ADAPTERS map not patched | upgrade fix-9r to v0.7.0+, run `fix-9r patch && fix-9r restart-9router` |

---

## Contributing

The whole patcher is **one file**: [`bin/fix-9router.js`](bin/fix-9router.js) (~1700 lines, no dependencies, ESM, Node 18+).

Layout inside that file:

```
imports + MARKERS                    – marker strings used to detect "already patched"
parseFlags / printHelp / fatal / fail
find9routerDir + helpers             – install path detection across environments
patchProviderModels                  – AG image model entry (PROVIDER_MODELS.ag)
patchPackagedProviderModels          – same on .next minified bundle
patchImageCore                       – legacy AG image core (≤v0.4.16)
patchPackagedImageRoute              – legacy AG image route (≤v0.4.16)
patchGc2Executor                     – gc/genlang/* model dispatch
patchPackagedGc2Executor             – minified counterpart
patchGc2Credentials                  – getProviderCredentials whitelist
patchPackagedGc2Credentials          – minified counterpart
patchAgPlugin                        – v0.4.18+ source: writes imageProviders/antigravity.js
patchPackagedAgPlugin                – v0.4.18+ packaged: injects IIFE into ADAPTERS map
cmdPatch / cmdStatus / cmdPrune      – core subcommands
cmdExpand / cmdDiscover / cmdUpdate
cmdInstall9router / cmdRestart9router / cmdCron
cmdUi                                – HTTP server + inline HTML dashboard
interactiveMenu / main()             – dispatcher
```

Conventions:
- One file. No build step. ESM with Node ≥ 18 only.
- All patches must be idempotent.
- All file writes must produce a `.bak-<timestamp>`.
- New subcommands: register in `main()`, in `printHelp()`, and in `interactiveMenu()`'s items list.
- No secrets in source — read at runtime from the user's 9router install.
- Every UI change must pass the puppeteer E2E in `tests/` (cache disabled, zero console errors expected).

PRs welcome. License: MIT.

---

## Repository

`https://github.com/dmdfami/fix-9router`
