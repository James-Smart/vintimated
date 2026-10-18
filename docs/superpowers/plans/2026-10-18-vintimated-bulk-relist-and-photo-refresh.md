# Vintimated: Bulk Relist + Photo Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork g1ampy/Bumpline into "Vintimated" and add the two features it lacks: relisting 1/many/all listings as a paced queue, and refreshing photos at upload so relists are not flagged as duplicates.

**Architecture:** Verbatim GPL-3.0 import of Bumpline's vanilla-JS MV3 sources as the baseline, then two new classic-script modules (`photo-refresh.js`, `bulk-queue.js`) with pure cores tested under `node --test`, wired into Bumpline's existing `relist()` flow at its photo-upload seam and its button/wardrobe seam. Bumpline's copy-before-delete safety sequence, pacing, and stop-on-refusal machinery are preserved untouched.

**Tech Stack:** Vanilla JS (classic content scripts, no bundler), Manifest V3 (Chrome/Edge/Firefox via `build.mjs`), Node built-in `node --test` for dev-time tests, IndexedDB for photo-byte recovery (already in baseline).

**Spec:** `docs/superpowers/specs/2026-10-18-vintimated-design.md`

## Global Constraints

- GPL-3.0: keep every upstream copyright header; add `Modifications Copyright (C) 2026 Vintimated contributors` beneath g1ampy's line in touched files; ship `LICENSE` unchanged.
- Zero runtime dependencies. Tests use Node's built-in `node --test` only. `build.mjs` stays dependency-free.
- New modules are classic scripts exposing one global (`PhotoRefresh`, `BulkQueue`) plus a CommonJS export guard (`typeof module !== 'undefined'` at file end) so tests can `require()` them.
- Every new runtime file goes into **both** `manifest.json` → `content_scripts[0].js` (before `content.js`) **and** `build.mjs` → `PAYLOAD`, or it will not ship.
- New UI strings go in `strings.js` under `en` only (verified: `t()` falls back `CATALOG[active][key] ?? CATALOG[BASE][key] ?? key`).
- Pacing defaults stay on and are never weakened: `PACE.safe.step = [900, 2400]`, `HARD_COOLDOWN_MS = 10000`, `HOUR_ALARM_AT = 4`, `DAY_ALARM_AT = 15`, stop-on-429/challenge with backoff.
- The copy-before-delete order in `relist()` never changes: photos uploaded and copy stashed → checks pass → `removeListing` → publish. No feature may reorder or skip these.
- Storage keys use the `vintimated:` prefix; IndexedDB name `vintimated` (renamed mechanically in Task 1).

## Review Focus

1. **A photo that fails to decode or render must not fail the relist** — the original bytes upload instead and the run continues. Pinned by Task 3's fallback tests (`decode`/`draw` stubs throwing).
2. **A refusal mid-queue (429 / bot challenge) must halt the queue with the remaining items untouched** — no half-deleted listings, `pending` reported. Pinned by Task 5's `isBlocked` test.
3. **"Relist all" must never queue sold or reserved items** — Vinted refuses to copy them and the run would stall. Pinned by Task 6's `filterEditable` test.
4. **The selection and bulk bar must survive Vinted re-rendering cards** (MutationObserver-driven re-attach) — selection is keyed by item id, never by DOM node. Pinned by Task 6's re-render verification step.
5. **The volume-alarm confirmation must fire once per queue with the planned count, never once per item.** Pinned by Task 5's `confirmStart` test.

---

## File Structure

| File | Role | Task |
| --- | --- | --- |
| (clone of g1ampy/Bumpline) | upstream source, imported verbatim then rebranded | 1 |
| `manifest.json`, `build.mjs`, `_locales/*/messages.json` | rebrand; later: register `photo-refresh.js` | 1, 3 |
| `photo-refresh.js` | **create** — photo transform: spec generation, pixel ops (pure), canvas adapter | 2, 3 |
| `bulk-queue.js` | **create** — sequential queue state machine (pure) | 5 |
| `content.js` | modify — photo upload seam (Task 3), `runRelist` extraction + `settle` option (Task 4), bulk UI/wiring (Task 6) | 3, 4, 6 |
| `strings.js` | modify — new setting/bulk strings under `en` | 3, 6 |
| `popup.html`, `popup.js`, `popup.css` | modify — photo-refresh setting row | 3 |
| `test/photo-refresh.test.js`, `test/bulk-queue.test.js`, `test/bulk-ui.test.js` | **create** — `node --test` suites | 2, 3, 5, 6 |
| `package.json` | **create** — `{ "scripts": { "test": "node --test \"test/**/*.test.js\"" } }`, no deps (the bare `test/` form fails on Node 22 — verified; see ledger ruling) | 2 |
| `README.md`, `CHANGELOG.md` | rewrite/extend — usage, safety, GPL attribution | 7 |

Baseline seams used (identifiers as imported in Task 1):
`relist(button, mode)` (content.js, orchestration), `attachButtons()` (button injection under `button[data-testid="bump-button"]` inside cards `[data-testid^="product-item-id-"]`), `itemIdFor(node)`, `canRelist(id)`, `grabPhoto(url) -> Promise<Blob>`, `sendPhoto(csrf, blob, sessionId) -> Promise<{id, orientation}>`, `refreshPhotos(csrf, itemId)` (recovery re-upload), `stashPhotos(itemId, blobs)`, `settle(itemId, message)`, `askToContinue({title, body, proceed, cancel})`, `readBlock()`, `readSetting(key, fallback)`, `step(pace)`, `pause(ms)`, `between(low, high)`, `relistLog()`, `countWithin(log, window)`, `bridgedFetch(url, options)`.

---

### Task 1: Import and rebrand the Bumpline baseline

**Files:**
- Create: everything from `https://github.com/g1ampy/Bumpline` (main branch) except `.git`, `.github`, `store/`
- Modify: every imported `.js`, `manifest.json`, `build.mjs`, `_locales/*/messages.json`, `popup.html`
- Create: `README.md` (rewrite), `.gitignore` (keep upstream's)

**Interfaces:**
- Produces: the whole baseline in the repo root, runnable via `node build.mjs`, git history starting with the import commit.

- [ ] **Step 1: Clone upstream and copy the sources in**

```bash
git clone --depth 1 https://github.com/g1ampy/Bumpline /tmp/opencode/bumpline
rsync -a --exclude '.git' --exclude '.github' --exclude 'store' /tmp/opencode/bumpline/ .
```

- [ ] **Step 2: Verify the untouched import builds**

Run: `node build.mjs`
Expected: `chrome: build/bumpline-<version>-chrome.zip` and the firefox equivalent, one line each. (Node 18+; no npm install exists or is needed.)

- [ ] **Step 3: Commit the verbatim import**

```bash
git init && git add -A
git commit -m "Import g1ampy/Bumpline 1.1.4 verbatim under GPL-3.0"
```

- [ ] **Step 4: Rebrand mechanically (single commit on top)**

Find-and-replace across the imported files — nothing semantic:
- `BumplineText` → `VintimatedText` (strings.js, background.js, content.js, popup.js, popup.html)
- `'bumpline:` → `'vintimated:` and `"bumpline:` → `"vintimated:` (storage keys and message type `bumpline:pageState`)
- `bumpline-` CSS class prefix → `vintimated-` (content.js `CLASS`/`SELECTOR`, popup.css, popup.html)
- `DB_NAME = 'bumpline'` → `'vintimated'`
- `[Bumpline]` console tag → `[Vintimated]`
- `_locales/*/messages.json`: `extName` = `Vintimated`; `extDescription` = `Relist one or many Vinted listings safely, with refreshed photos.` (other locales keep English text)
- `manifest.json` `"action": { "default_title": "Vintimated" }`; `build.mjs` `GECKO_ID` → `vintimated@users.noreply.github.com`
- In files you touch, add under g1ampy's header line: `// Modifications Copyright (C) 2026 Vintimated contributors.`
Do **not** rename `button.*`/`toast.*` string keys or upstream comments.

- [ ] **Step 5: Rewrite README.md**

Sections: what Vintimated does (single + bulk relist, photo refresh — honest that bulk/photo land in later tasks of this branch), installation from source (`node build.mjs` + load unpacked), "Based on Bumpline by g1ampy — GPL-3.0" with link, the ToS risk paragraph (automation is very likely against Vinted's terms; you are responsible for how you use this), and "Not affiliated with, endorsed by, or connected to Vinted".

- [ ] **Step 6: Verify the rebranded build still packages**

Run: `node build.mjs && unzip -l build/vintimated-1.1.4-chrome.zip | head -20`
Expected: zip contains `manifest.json`, `content.js`, `strings.js`, `_locales/…`; `grep -r Bumpline --include='*.js' .` returns zero matches in code and string literals (comment lines naming the upstream project are permitted; comments naming renamed identifiers must name the new identifier).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Rebrand to Vintimated; preserve GPL-3.0 attribution"
```

---

### Task 2: Photo-refresh core (pure module, TDD)

**Files:**
- Create: `photo-refresh.js`
- Create: `test/photo-refresh.test.js`
- Create: `package.json`

**Interfaces (later tasks rely on these exact names):**
- `PhotoRefresh.rng(seed?: number) -> () => number` — returns values in [0, 1); deterministic for a given seed.
- `PhotoRefresh.generateSpec(mode: 'off'|'stealth'|'bordered', rng: () => number) -> Spec`
- `PhotoRefresh.geometry(width: number, height: number, angleRad: number, scale: number) -> { drawW, drawH, offsetX, offsetY }`
- `PhotoRefresh.applyPixels(data: Uint8ClampedArray, spec: Spec, rng: () => number) -> void`
- `PhotoRefresh.MODES = ['off', 'stealth', 'bordered']`
- `Spec = { enabled: boolean, angleRad: number, scale: number, channelShift: [number, number, number], noiseAmp: number, border: null | { widthPct: number, rgba: [number, number, number, number] } }`

Bounds the tests pin: `|angleRad| <= 0.0209` rad (1.2°); `1.02 <= scale <= 1.05`; `|channelShift[i]| <= 6` (integers); `noiseAmp` integer in 1..3; `border === null` for `'stealth'`, `border.widthPct` in 0.010..0.020 with `rgba = [255, 255, 255, 255]` for `'bordered'`; `enabled === false` for `'off'`.

- [ ] **Step 1: Write the failing test**

`test/photo-refresh.test.js` (via `require('../photo-refresh.js')`, `node:test` + `node:assert/strict`):
- `generateSpec('off', rng(1)).enabled === false`
- determinism: `generateSpec('stealth', rng(7))` deep-equals itself across two runs; differs from `rng(8)`'s
- bounds: loop 50 seeds, assert every field within the bounds above; `border` non-null exactly for `'bordered'`
- `geometry(4000, 3000, 0.02, 1.05)`: `drawW >= 4000 && drawH >= 3000` (rotated source is covered), `offsetX === (4000 - drawW) / 2`, `offsetY === (3000 - drawH) / 2`
- `applyPixels` on a 2-pixel RGBA buffer with a hand-built spec `{enabled:true, channelShift:[5,-5,0], noiseAmp:0, …}`: R+5, G−5, B and A unchanged per pixel; clamping: a pixel at R=253 with shift 5 ends at 255; at G=2 with shift −5 ends at 0

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../photo-refresh.js'`

- [ ] **Step 3: Implement `photo-refresh.js`**

Classic script IIFE assigning `const PhotoRefresh = (() => { … })()` with the interface above, plus the CommonJS guard. `geometry` maths: `drawW = (w·|cos θ| + h·|sin θ|) · scale`, `drawH = (w·|sin θ| + h·|cos θ|) · scale`, offsets centered. `applyPixels` iterates channels R/G/B (never A), adds `channelShift` then `noise` in `±noiseAmp`, clamps to 0..255.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all assertions green)

- [ ] **Step 5: Commit**

```bash
git add photo-refresh.js test/photo-refresh.test.js package.json
git commit -m "Add photo-refresh core: spec, geometry, pixel ops"
```

---

### Task 3: Photo-refresh adapter, upload hook, and setting

**Files:**
- Modify: `photo-refresh.js` (add `refresh`), `content.js` (photo loop + `refreshPhotos`), `manifest.json`, `build.mjs`, `strings.js`, `popup.html`, `popup.js`, `popup.css`
- Test: `test/photo-refresh.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `PhotoRefresh.*`.
- Produces: `PhotoRefresh.refresh(blob: Blob, options: { mode, seed?: number, maxEdge?: number = 2048, quality?: number = 0.92 }, deps?: { decode, draw }) -> Promise<Blob>` where `decode(blob) -> Promise<{width, height}>` and `draw(bitmap, spec, options) -> Promise<Blob>` default to browser implementations (createImageBitmap + canvas → JPEG `toBlob`). Returns **the input blob unchanged** when `mode === 'off'` or on any thrown error.
- Produces: setting key `vintimated:photoRefresh` (values `'off'|'stealth'|'bordered'`, default `'bordered'`), read by `photoRefreshMode()` in content.js.

- [ ] **Step 1: Write the failing tests**

Append to `test/photo-refresh.test.js`:
- `mode:'off'` → resolves to the **same blob instance**, `decode` stub never called
- `decode` stub throws → resolves to the original blob
- `draw` stub throws → resolves to the original blob
- success path with stubs → resolves to the stub's output blob; `draw` received a spec with `enabled: true`; `border` non-null for `'bordered'`, null for `'stealth'`
- explicit `seed` is honored: same seed twice → `draw` stub receives deep-equal specs

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `PhotoRefresh.refresh is not a function`

- [ ] **Step 3: Implement `refresh` and the browser `draw` adapter in `photo-refresh.js`**

`refresh` orchestrates: mode check → `decode` → `generateSpec` with `rng(options.seed)` → `draw` (browser impl: cover-fill via `geometry`, rotate about centre, `applyPixels` on `getImageData`/`putImageData`, thin border rect for `bordered`, JPEG `toBlob(options.quality)`, downscale so max edge ≤ `options.maxEdge`) → wrap any throw in a `trace`-less silent catch returning the input blob.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Hook the upload path in `content.js`**

In `relist()`'s photo loop, after `const blob = await grabPhoto(url)`:
- `const outgoing = await PhotoRefresh.refresh(blob, { mode: await photoRefreshMode() });`
- `blobs.push(blob)` keeps the **original** bytes (recovery/downloads stay pristine); `sendPhoto(csrf, outgoing, sessionId)` sends the refreshed bytes.
In `refreshPhotos()` (recovery re-upload), refresh before `sendPhoto` the same way. Add `photoRefreshMode()` = `readSetting('vintimated:photoRefresh', 'bordered')` validated against `PhotoRefresh.MODES` (unknown value → `'bordered'`).

- [ ] **Step 6: Register the file and add the setting row**

`manifest.json` → `content_scripts[0].js`: `["strings.js", "photo-refresh.js", "content.js"]`. `build.mjs` → `PAYLOAD`: add `'photo-refresh.js'`. `popup.html`/`popup.js`: one settings row following the existing rows' pattern — label `T('setting.photoRefresh')`, a 3-option control bound to `vintimated:photoRefresh`, help line per option (`setting.photoRefresh.off|stealth|bordered.help`). Strings in `strings.js` `en`.

- [ ] **Step 7: Verify against a live listing (manual)**

Load unpacked on a Vinted wardrobe; relist one item in each mode. Expected: network tab shows `POST /api/v2/photos` bodies with sizes differing from the downloaded originals; `bordered` mode shows a thin white border on the new listing; a PNG-sourced photo uploads fine as JPEG; disabling the setting (`off`) uploads unchanged bytes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Refresh photos at upload; photoRefresh setting (off/stealth/bordered)"
```

---

### Task 4: Extract a headless relist runner

**Files:**
- Modify: `content.js` (`relist`, `settle`)

**Interfaces:**
- Produces: `runRelist(itemId: string|number, mode: 'publish'|'draft', hooks: { label(text: string), busy(isBusy: boolean), card?(): Element|null, reload?: boolean }) -> Promise<void>` — the full body of today's `relist()` minus button lookup/disposal: pending-resume check, refusal gate, cooldown, budget alarm (`askToContinue`), photo/upload/check/stash/delete/publish sequence. `hooks.card` supplies the item card for the scroll-to-card pause (the wrapper passes `button.closest(SELECTOR.card)`; headless callers may omit or supply their own). `hooks.reload === false` passes `{ reload: false }` through to `settle`, which then only `dropCard(itemId)` + toast.
- Produces: `settle(itemId, message, options?: { reload?: boolean })` (default `reload: true` — existing behavior preserved).
- `relist(button, mode)` remains and is now a thin wrapper: `itemIdFor(button)`, `hooks = { label: t => setButtonLabel(button, t), busy: on => button.disabled = on + class toggle }`, then `runRelist(...)`.

- [ ] **Step 1: Extract `runRelist` and adapt `relist`**

Move the body verbatim; `button`-specific calls become `hooks.*` calls. No behavior change: `relist` callers in `attachButtons()` stay untouched. `settle` gains the options argument and honors `reload === false`.

- [ ] **Step 2: Verify single-item behavior is unchanged (manual)**

Load unpacked; relist one item (publish) and one (draft). Expected: identical label sequence (`Relisting… → Checking size… → Saving the copy… → Deleting… → Publishing…`), page reloads after when the reload setting is on, nothing deleted on a forced failure (kill network after photos: item intact, copy recoverable).

- [ ] **Step 3: Verify tests still pass**

Run: `npm test`
Expected: PASS (Task 2/3 suites unaffected)

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "Extract runRelist(itemId, mode, hooks) for headless runs"
```

---

### Task 5: Bulk queue state machine (pure module, TDD)

**Files:**
- Create: `bulk-queue.js`
- Create: `test/bulk-queue.test.js`

**Interfaces:**
- `BulkQueue.create({ ids: number[], runOne: (id: number) => Promise<void>, nextGap: () => number, wait: (ms: number) => Promise<void>, isBlocked: () => boolean|Promise<boolean> }) -> { run(opts), stop() }`
- `run({ confirmStart: (count: number) => boolean|Promise<boolean>, onProgress?: ({index, total, id}) => void, onItemDone?: ({id, ok, error}) => void }) -> Promise<Result>`
- `Result = { status: 'done'|'stopped'|'halted', completed: number[], failed: Array<{id: number, error: Error}>, pending: number[] }`
- Semantics: `confirmStart(total)` is called exactly once, before anything runs; items run sequentially in `ids` order; `wait(nextGap())` runs **between** items only (n−1 gaps); `stop()` ends the queue after the current item (current item always finishes; result `status:'stopped'`, not-yet-started ids in `pending`); `isBlocked()` truthy before starting an item → `status:'halted'`, that id and the rest in `pending`; a `runOne` rejection lands in `failed` and the queue continues, unless the error carries `.hard === true`, which halts like a block.

- [ ] **Step 1: Write the failing test**

`test/bulk-queue.test.js` (stub `wait` records ms and resolves; `runOne` records order):
- runs `[1,2,3]` in order; `wait` called exactly twice, each with the value `nextGap()` returned
- `stop()` called during item 2 → `completed:[1,2]`, `pending:[3]`, `status:'stopped'`
- `isBlocked` false for the first two items, true before item 3 → `completed:[1,2]`, `pending:[3]`, `status:'halted'`
- `runOne(2)` rejects (soft) → `failed:[{id:2}]`, `completed:[1,3]`, `status:'done'`
- `runOne(2)` rejects with `error.hard = true` → `status:'halted'`, `pending:[3]`
- `confirmStart` resolves `false` → `status:'stopped'`, `runOne` never called, `confirmStart` called once; on the happy path it is also called exactly once

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../bulk-queue.js'`

- [ ] **Step 3: Implement `bulk-queue.js`**

Classic script + CommonJS guard exposing `BulkQueue.create` per the interface. No timers of its own — `wait` is always injected; a `stopRequested` flag is checked before each item starts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bulk-queue.js test/bulk-queue.test.js
git commit -m "Add bulk queue state machine with stop/halt semantics"
```

---

### Task 6: Bulk selection UI and wiring

**Files:**
- Modify: `content.js` (bulk section: selection state, checkboxes, bar, enumeration), `strings.js` (`bulk.*` keys under `en`)
- Test: `test/bulk-ui.test.js`

**Interfaces:**
- Consumes: `BulkQueue.create` (Task 5), `runRelist` + `settle` (Task 4), baseline `bridgedFetch`, `itemIdFor`, `canRelist`, `SELECTOR.card`, `askToContinue`, `readBlock`, `relistLog`, `countWithin`, `pause`, `between`, `reloadWanted`, `toast`, `T`.
- Produces (content.js, also exported for tests via the same global/CJS guard pattern): `filterEditable(items: object[], isEditable: (item) => boolean) -> number[]` — ids of items the predicate accepts.
- Produces: `selection: Map<string, true>` keyed by item id (survives card re-render); bulk bar element `#vintimated-bulkbar` with buttons: `bulk.bar.selectLoaded`, `bulk.bar.clear`, `bulk.bar.relistSelected` (label carries count), `bulk.bar.relistAll`, `bulk.bar.stop` (enabled only while a queue runs).

- [ ] **Step 1: Write the failing test for `filterEditable`**

`test/bulk-ui.test.js`: five fake items (`{id, status}`: active, active, sold, reserved, active) with `isEditable = item => item.status === 'active'` → returns `[id1, id2, id5]`. Empty input → `[]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `filterEditable is not defined`

- [ ] **Step 3: Implement selection + checkboxes + bar in `content.js`**

Add a bulk section near `attachButtons`. A checkbox (`input.vintimated-select`) is appended to each relistable card's button host (skipping cards where `canRelist(id)` is false); toggling updates `selection` by id; checkbox `checked` is re-synced from `selection` on every `attachButtons()` pass so MutationObserver re-renders cannot lose it. The fixed bar shows `bulk.bar.selected` with the live count and is hidden while no cards exist. Register `photo-refresh.js`-style globals as needed so `test/bulk-ui.test.js` can `require` the file (or put `filterEditable` in `bulk-queue.js` — implementer's choice, one home only).

- [ ] **Step 4: Implement enumeration and the queue wiring**

`enumeratedIds()` for **Relist all**: read member id from `location.pathname` (`/member/(\d+)/`), page `bridgedFetch(`${SITE}/api/v2/users/${userId}/items?per_page=96&page=N`)` until an empty page (cap 50 pages), collect `filterEditable(items, isEditable)` where `isEditable` matches the live item status field (verify in the network tab; document the field in a code comment). If the endpoint shape has changed or errors, fall back to the ids currently in the DOM (`SELECTOR.card` + `itemIdFor`, `canRelist` filtered) and say so in the toast.
Run: `BulkQueue.create({ ids, runOne: id => runRelist(id, 'publish', { label: t => …, busy: () => {}, card: () => document.querySelector(`[data-testid="product-item-id-${id}"]`), reload: false }), nextGap: () => between(10000, 30000), wait: pause, isBlocked: async () => Boolean(await readBlock()) })`.
`confirmStart(count)`: proceed silently when `countWithin(await relistLog(), DAY_WINDOW_MS) + count < DAY_ALARM_AT` and the hourly window is clear; otherwise one `askToContinue` with `budget.title.day|hour` and new `bulk.budget.body` (`{0}` = count). Because `runRelist`'s own budget gate would otherwise re-ask per item once the limits trip, `runRelist`'s hooks gain `budgetPreapproved?: boolean` (default false, single-item behavior unchanged); the bulk runner passes `budgetPreapproved: true` after its single `confirmStart`. Progress label via `onProgress` (`bulk.progress` = `'{0}/{1}'`). Per-item `settle(id, …, { reload: false })`; after the whole queue: summary toast `bulk.done` (`{0}` completed, `{1}` failed) or `bulk.halted`, then one `location.reload()` when `reloadWanted()`.

- [ ] **Step 5: Add `bulk.*` strings to `strings.js` (en)**

Keys: `bulk.bar.selected`, `bulk.bar.selectLoaded`, `bulk.bar.clear`, `bulk.bar.relistSelected`, `bulk.bar.relistAll`, `bulk.bar.stop`, `bulk.progress`, `bulk.done`, `bulk.halted`, `bulk.stopped`, `bulk.budget.body`, `bulk.confirmAll` (confirmation body for "Relist all" stating the count).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Verify bulk behavior (manual)**

Load unpacked on a wardrobe with ≥3 relistable items:
- select 2 of 3 → `Relist selected (2)` runs them in order, ~20–40s apart (10s hard cooldown plus the 10–30s gap), page does not reload between items, one reload at the end
- press **Stop** mid-item → the running item finishes, nothing new starts, summary says so
- flip `vintimated:blockedUntil` in extension storage mid-run (or throttle to provoke a 429) → queue halts, remaining items untouched
- **Relist all** on a wardrobe containing a sold item → the sold item is never queued
- scroll away and back (cards re-render) → selections persist

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Bulk relist: selection UI, queue wiring, all-items enumeration"
```

---

### Task 7: Docs, changelog, and packaging

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Verify: `build/` output (not committed)

**Interfaces:** none (documentation and packaging only).

- [ ] **Step 1: README**

Document: both features with the settings table (`vintimated:photoRefresh` values and what each changes), bulk usage (select/stop/all semantics), the safety story (copy-before-delete, recovery box, stop-on-refusal), pacing defaults and why they stay on, ToS risk paragraph, GPL-3.0 + Bumpline attribution, "not affiliated with Vinted".

- [ ] **Step 2: CHANGELOG**

Bump `manifest.json` `version` to `1.2.0`, and a `1.2.0` changelog entry: bulk relist, photo refresh, credits to g1ampy/Bumpline.

- [ ] **Step 3: Build both targets and sanity-check**

Run: `node build.mjs && npm test && npx --yes web-ext lint --source-dir build/vintimated-1.2.0-firefox`
Expected: both zips written, tests PASS, web-ext lint reports no errors (warnings acceptable).

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md manifest.json
git commit -m "Docs and 1.2.0 packaging"
```
