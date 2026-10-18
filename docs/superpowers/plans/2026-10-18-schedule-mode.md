# Schedule Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-form scheduler that relists qualifying items over a period — only while the browser is open, through the existing `runRelist`, with Stop/Abort — spaced so Vinted never sees automated activity.

**Architecture:** A new pure module `scheduler.js` owns every time decision (windows, gaps, caps, eligibility, state transitions) and is tested under `node --test`. `background.js` keeps the schedule alive with a cheap `chrome.alarms` wake (browser-open only) and owns the engine tab; `content.js` in that tab makes the firing decision and calls `runRelist` — never a new relist path. The popup holds the validated form; the wardrobe bar holds the running strip.

**Tech Stack:** Vanilla JS classic scripts (no bundler), Manifest V3 (Chrome/Edge/Firefox via `build.mjs`), `chrome.alarms` + `chrome.tabs` + `chrome.storage`, Node built-in `node --test` for dev tests.

**Spec:** `docs/superpowers/specs/2026-10-18-schedule-mode-design.md`

## Global Constraints

- GPL-3.0: keep upstream copyright headers; `Modifications Copyright (C) 2026 Vintimated contributors` on touched files; new files carry the Vintimated GPL-3.0 notice block.
- Zero runtime dependencies. Tests use Node's built-in `node --test` only. `build.mjs` stays dependency-free.
- New modules are classic scripts exposing one global (`Scheduler`) plus a CommonJS export guard (`typeof module !== 'undefined'` at file end).
- Every new runtime file goes into **both** `manifest.json` → `content_scripts[0].js` (before `content.js`) **and** `build.mjs` → `PAYLOAD`. New permissions (`alarms`) go in `manifest.json` → `permissions`.
- New UI strings go in `strings.js` under `en` only (fallback to `en` is built in).
- Pacing defaults stay on and are never weakened: `PACE.safe.step = [900, 2400]`, `HARD_COOLDOWN_MS = 10000`, `HOUR_ALARM_AT = 4`, `DAY_ALARM_AT = 15`, stop-on-429/challenge with backoff.
- The copy-before-delete order in `relist()` never changes. The scheduler is just another caller of `runRelist(itemId, mode, hooks)`.
- **The schedule never prompts.** No modal may appear because of a scheduled firing; when a firing would cross the volume alarms it holds and retries at the next slot (`budgetPreapproved: true` is passed only after that pre-check).
- **Nothing runs while the browser is closed, and missed slots are never backfilled.** No detection-evasion machinery of any kind: when Vinted pushes back, the schedule pauses with the existing stand-down.

## Review Focus

1. **A scheduled firing must never pop a dialog mid-browse** — hold-and-skip when the shared `relistLog` is near `HOUR_ALARM_AT`/`DAY_ALARM_AT`. Pinned by Task 4's hold-and-skip test.
2. **Missed slots must never backfill** — two days of closed browser yield at most one firing on return, inside a window. Pinned by Task 1's `decide` tests and Task 3's single-fire-per-wake step.
3. **The daily cap counts manual and scheduled relists alike** (shared `vintimated:relistLog`). Pinned by Task 1's capacity test with a pre-loaded count.
4. **One firing scheduler across tabs** — a storage lease makes a stale or second engine tab inert. Pinned by Task 2's lease test.
5. **Stop ends the period cleanly and Abort cancels outright** — no orphan engine tab, no zombie running state, form values preserved. Pinned by Task 1's transition tests and Task 5's manual checklist.

---

## File Structure

| File | Role | Task |
| --- | --- | --- |
| `scheduler.js` | **create** — pure schedule logic: windows, gaps, caps, eligibility, state transitions, lease validation | 1, 2, 4 |
| `test/scheduler.test.js` | **create** — `node --test` suite for the above | 1, 2, 4 |
| `background.js` | modify — `chrome.alarms` wake, engine-tab open/adopt/close, popup↔engine message relay | 2, 3 |
| `content.js` | modify — engine loop (decide → pick → `runRelist` → record), eligibility feed, running strip hook | 3, 4, 5 |
| `popup.html`, `popup.js`, `popup.css` | modify — schedule form (validated knobs), Start/Stop/Abort, paused/running states | 5 |
| `strings.js` | modify — `schedule.*` strings under `en` | 5 |
| `manifest.json`, `build.mjs` | modify — `alarms` permission, `scheduler.js` registration | 2 |
| `README.md`, `CHANGELOG.md` | rewrite/extend — schedule docs, 1.3.0 entry | 6 |

Seams used (as they exist after the released 1.2.1): `runRelist(itemId, mode, hooks)` with `hooks = { label, busy, card?, reload?, budgetPreapproved? }` returning `Promise<boolean>`; `BulkQueue.filterEditable(items, isEditable)`; `enumeratedIds()` ladder (`users/items` → `wardrobe/items` → DOM); `isCopyable` semantics; `relistLog()` / `countWithin()` / `noteRelist()`; `readBlock()` / `noteRefusal` stand-down; `LAST_PROFILE_KEY` (remembered profile URL); `readSetting`/`ext.storage.local`; `attachButtons()` + the bulk bar idiom.

---

### Task 1: `scheduler.js` — windows, caps, decisions, transitions (pure core, TDD)

**Files:**
- Create: `scheduler.js`
- Create: `test/scheduler.test.js`

**Interfaces (later tasks rely on these exact names):**
- `Scheduler.isWithinWindow(defn, now) -> boolean` — `defn.days` (array of 0–6, Sun=0), `defn.fromMin`/`defn.toMin` (local minutes-of-day, `fromMin <= toMin`), `defn.endsAt` (ms timestamp): true only inside a day+hour window and before the period end.
- `Scheduler.nextGapMs(defn, rand) -> number` — integer ms in `[defn.gapMinMs, defn.gapMaxMs]` using the injected `rand()` in [0,1).
- `Scheduler.capacityLeft(defn, todayCount) -> number` — `Math.max(0, defn.maxPerDay - todayCount)`, never negative.
- `Scheduler.decide(defn, now, ctx) -> { action: 'fire'|'wait', reason, waitMs }` — `ctx = { lastFireAt, todayCount, pausedUntil }`. Reasons in priority order: `'period-over'` (wait, waitMs 0), `'paused'` (wait until `pausedUntil`), `'outside-window'` (wait until the next window start, computed in local time), `'gap'` (wait until `lastFireAt + nextGap` is due — `nextGap` is drawn once per decision from `nextGapMs`), `'cap'` (wait until tomorrow's window start), `'fire'`. `action:'fire'` only when all gates pass.
- `Scheduler.eligible(defn) -> (item) => boolean` — `item = { ageDays, closed }`: `!closed && ageDays >= defn.ageThresholdDays`.
- `Scheduler.inScope(defn, itemId, selection: Set) -> boolean` — `'all'` → true; `'selected'` → `selection.has(itemId)`.
- `Scheduler.transition(state, event) -> state` — events: `{type:'start', defn, now}`, `{type:'fire', now, id}`, `{type:'stop', now}`, `{type:'abort', now}`, `{type:'pause', until}`, `{type:'resume', now}`. State: `{ status: 'idle'|'running'|'ended'|'cancelled', defn, startedAt, endsAt, lastFireAt, dayKey, dayCount, doneIds }`. `fire` increments `dayCount`, appends `id` to `doneIds`, rolls `dayKey`/`dayCount` on a new local day. `stop` → `ended` (keeps `defn`); `abort` → `cancelled` (clears `endsAt`/counters/`doneIds`, keeps `defn` for re-start).
- `Scheduler.dayKey(now) -> string` — local `YYYY-MM-DD`.
- `Scheduler.leaseValid(lease, now) -> boolean` — `{tabId, until}`: valid when `now < until`.
- `Scheduler.serialize(state)` / `Scheduler.deserialize(raw)` — JSON round-trip; `deserialize` returns a fresh `idle` state for anything malformed.

- [ ] **Step 1: Write the failing tests** (`test/scheduler.test.js`, seeded `rand = () => 0.5` style injection):
  - `isWithinWindow`: inside 18:00–21:00 on an allowed day → true; 17:59 and 21:00 → false; allowed hour on a disallowed day → false; after `endsAt` → false even in-window
  - `nextGapMs`: 50 draws land in `[gapMinMs, gapMaxMs]` for both `rand` extremes (0 and 0.999…)
  - `capacityLeft`: counts 0, `maxPerDay`, and over-cap all yield ≥ 0 with the right values
  - `decide`, one test per reason: `period-over`, `paused`, `outside-window` (returns `waitMs` reaching exactly the next window start), `gap` (not due yet), `cap` (todayCount at cap → wait to next day), and `fire` when all gates pass
  - **no backfill:** `decide` after a 3-day gap in `now` returns exactly one `fire` (a single decision — no replay of missed slots is possible by construction)
  - `transition`: start → running with `endsAt = now + periodMs`; fire increments `dayCount`, appends the fired `id` to `doneIds`, and rolls the day; stop → `ended` with `defn` kept; abort → `cancelled` with counters and `doneIds` cleared
  - `eligible`: age below/above threshold; `closed` always false
  - `inScope`: `'all'` vs `'selected'` with a `Set`
  - `leaseValid`: before/after `until`
  - `serialize`/`deserialize`: round-trip deep-equal; garbage input → `idle` state
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL — `Cannot find module '../scheduler.js'`
- [ ] **Step 3: Implement `scheduler.js`** — classic script IIFE assigning `const Scheduler = (() => { … })()` with the interface above plus the CommonJS guard. `decide` draws its gap once via `nextGapMs(defn, () => 0.5)`-style injected default `Math.random`; all time math uses `Date` methods on `now` (a `Date` or ms) in the seller's local timezone.
- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS (Task suites green)
- [ ] **Step 5: Commit**
  ```bash
  git add scheduler.js test/scheduler.test.js
  git commit -m "Add schedule core: windows, gaps, caps, transitions"
  ```

---

### Task 2: Persistence, lease, and the wake wire (background.js)

**Files:**
- Modify: `background.js` (alarms + message relay), `manifest.json` (`alarms` permission), `build.mjs` (`scheduler.js` in `PAYLOAD`)
- Modify: `scheduler.js` (only if a helper is missing — `leaseValid`/`serialize` exist from Task 1)

**Interfaces:**
- Consumes: Task 1's `Scheduler.*`.
- Produces: storage key `vintimated:schedule` = `Scheduler` state (serialized); lease key `vintimated:schedule.lease` = `{ tabId, until }` (renewed 5 min ahead by the engine tab).
- Produces: alarm `vintimated:schedule-wake`, `periodInMinutes: 1`, (re)created whenever the stored state is `running`; deleted when it is not. The alarm handler only posts `vintimated:schedule.wake` to the engine tab(s) — it never relists itself.
- Produces: message types `vintimated:schedule.start|stop|abort|status|wake` (popup ↔ background ↔ content), answered with `{ state, defn }` for `status`.

- [ ] **Step 1: Write the failing tests** (append to `test/scheduler.test.js`) for the one new pure helper this task adds: `Scheduler.renewLease(now, tabId) -> { tabId, until }` — `until` exactly `now + 5 * 60 * 1000`; with `Scheduler.leaseValid` covering expiry (stale lease → false). TDD: tests first, watch them fail.
- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL on the new assertions (helpers exist — if they pass immediately, tighten the assertions to the shapes above)
- [ ] **Step 3: Implement the background wiring**
  - `chrome.alarms.onAlarm` for `vintimated:schedule-wake` → `chrome.tabs.query({ url: vinted-wardrobe-patterns })` → post `wake` to those tabs.
  - `runtime.onMessage` for `start|stop|abort|status`: `start` creates/updates the alarm and opens or adopts the engine tab (Task 3 hooks in here); `stop|abort` clear the alarm.
  - `manifest.json` → `permissions: ["storage", "webRequest", "alarms"]`; `build.mjs` → `PAYLOAD` gains `scheduler.js`.
- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add background.js manifest.json build.mjs scheduler.js test/scheduler.test.js
  git commit -m "Schedule wake wire: alarms, storage, message relay"
  ```

---

### Task 3: Engine tab and the firing loop (content.js)

**Files:**
- Modify: `content.js` (engine loop + wake handler), `background.js` (engine-tab open/adopt/close)

**Interfaces:**
- Consumes: `Scheduler.decide/isWithinWindow/transition/serialize/deserialize/leaseValid/dayKey`, `runRelist(itemId, mode, hooks)`, `readBlock()`, `relistLog()`, `countWithin()`, `LAST_PROFILE_KEY`.
- Produces: engine behavior — on `wake` or page load with a `running` schedule: claim/renew the lease (`vintimated:schedule.lease`), `Scheduler.decide(...)`, and on `'fire'`: pick one eligible item (Task 4's feed), run `runRelist(id, 'publish', { label, busy: () => {}, card: () => engineCard(id), reload: false, budgetPreapproved: true })`, `Scheduler.transition(state, { type: 'fire', now })`, persist. Exactly one firing per wake.
- Produces: engine tab lifecycle — `start` opens `LAST_PROFILE_KEY`'s wardrobe if no wardrobe tab exists (or adopts one); the tab closes when the state leaves `running` (stop/abort/period end) or the extension is switched off.

- [ ] **Step 1: Extract and test the pure parts** — `Scheduler.pickNext(items, defn, selection)` (append to `test/scheduler.test.js`): among `[{id, ageDays, closed}]`, return the first id passing `eligible` + `inScope` in input order; none → null. TDD: failing test first.
- [ ] **Step 2: Implement the loop** — `wake` handler as described; **one firing per wake** (the no-backfill property); a second wake during an in-flight `runRelist` finds the lease held and does nothing. Engine tab is pinned to the wardrobe (if the seller navigates it away, the next wake re-navigates it to the remembered profile).
- [ ] **Step 3: Verify**
  Run: `npm test` and `node build.mjs`
  Expected: PASS; both zips contain `scheduler.js`; `manifest.json` in the zips lists `alarms`.
- [ ] **Step 4: Commit**
  ```bash
  git add content.js background.js scheduler.js test/scheduler.test.js
  git commit -m "Schedule engine: lease-claimed firing loop on wake"
  ```

---

### Task 4: Eligibility feed and hold-and-skip (content.js)

**Files:**
- Modify: `content.js` (feed + budget pre-check), `scheduler.js` (pure predicate), `test/scheduler.test.js`

**Interfaces:**
- Consumes: `enumeratedIds()` ladder and its item payloads (which carry the fields `isCopyable` reads and the age source used by `paintAgeLabels`), `BulkQueue.filterEditable`, `relistLog()`, `countWithin()`, `HOUR_ALARM_AT`, `DAY_ALARM_AT`.
- Produces: `Scheduler.holdForBudget(counts) -> { hold: boolean, until: 'hour'|'day'|null }` — pure; `counts = { thisHour, today }`: hold when `today + 1 > DAY_ALARM_AT` or `thisHour + 1 > HOUR_ALARM_AT` (the shared-log guarantee: manual relists count, since `relistLog` is one log).
- Produces: feed — `nextEligibleItem()` in content.js: live ladder items filtered by `isCopyable`/`filterEditable`, `Scheduler.eligible(defn)` (age ≥ threshold), `Scheduler.inScope(defn, id, selection)`, and never an id already relisted by the schedule this period (`state.doneIds` — small array in the state, so a period relists each item at most once even if its age qualifies again after a shorter threshold).

- [ ] **Step 1: Write the failing test** for `holdForBudget`: at `DAY_ALARM_AT`-1 with room in the hour → not held; at `DAY_ALARM_AT` → held (`until: 'day'`); at `HOUR_ALARM_AT` with day room → held (`until: 'hour'`); manual counts included (`scheduledToday: 0` but `today` high → held).
- [ ] **Step 2: Run tests to verify they fail** — Run: `npm test` — Expected: FAIL
- [ ] **Step 3: Implement `holdForBudget` + `nextEligibleItem` + `doneIds` bookkeeping** — on `hold`, the firing records nothing and the next wake re-decides (the `decide` gap already spaces attempts).
- [ ] **Step 4: Run tests to verify they pass** — Run: `npm test` — Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add content.js scheduler.js test/scheduler.test.js
  git commit -m "Schedule feed: eligibility, scope, hold-and-skip budget gate"
  ```

---

### Task 5: The form, the strip, the strings (popup + bar)

**Files:**
- Modify: `popup.html`, `popup.js`, `popup.css` (schedule form section), `content.js` (running strip on the bulk bar), `strings.js` (`schedule.*` under `en`)

**Interfaces:**
- Consumes: `vintimated:schedule` state via `ext.storage.local`; message `vintimated:schedule.status`; the bulk bar's paint idiom.
- Produces: the validated form — one panel, every knob visible: Period (starts on Start; Ends date), Days (seven toggles), Hours (from–to), Max relists per day, Gap between relists (min–max minutes), Item age threshold (days), Scope (`all` / `selected`), and Start / Stop / Abort. Defaults exactly: ends +7 days, all days, 18:00–21:00, 6/day, 35–90 min, 10+ days, `all`.
- Produces: running strip on the wardrobe bar (reusing the bulk bar section or its own line): `Schedule running · next relist in ~N min · k of cap today · ends <date>`, plus `paused until <time>` when the stand-down is active, with Stop/Abort buttons (Abort needs a confirm click — it cancels).
- Produces: strings — `schedule.*` (`schedule.form.*`, `schedule.strip.*`, `schedule.stop`, `schedule.abort`, `schedule.abort.confirm`) under `en`.

- [ ] **Step 1: Implement the form and the strip** following the existing popup-row and bar idioms; the form writes `vintimated:schedule` via the `start` message; `stop`/`abort` messages clear the alarm (Task 2) and close the engine tab.
- [ ] **Step 2: Add strings** under `en` in `strings.js` (build's catalogue check enforces the `en`-authoritative rule from the rebrand).
- [ ] **Step 3: Verify**
  Run: `npm test && node build.mjs && npx --yes web-ext lint --source-dir build/vintimated-1.3.0-firefox`
  Expected: PASS / both zips / 0 errors.
- [ ] **Step 4: Manual checklist (human, live Vinted)** — start a schedule; watch the strip count down and fire once; Stop ends it after the current relist; Abort cancels and the engine tab closes; browsing elsewhere in the browser doesn't disturb it; closing the browser overnight produces no burst on return.
- [ ] **Step 5: Commit**
  ```bash
  git add -A
  git commit -m "Schedule UI: one-form setup panel and running strip"
  ```

---

### Task 6: Docs, version, packaging

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `manifest.json` (version `1.3.0`), `package.json` (version)

**Interfaces:** none (documentation and packaging).

- [ ] **Step 1: README** — a Schedule section: what it does (relists qualifying items over a period while the browser is open), the form's knobs and defaults table, Stop vs Abort, the honest lines (never prompts, no catch-up, pauses when Vinted pushes back, ToS risk unchanged), and the note that the scheduler keeps its own wardrobe tab.
- [ ] **Step 2: CHANGELOG `1.3.0` + version bump** (manifest + package.json), crediting g1ampy/Bumpline as before.
- [ ] **Step 3: Build and sanity-check**
  Run: `node build.mjs && npm test && npx --yes web-ext lint --source-dir build/vintimated-1.3.0-firefox`
  Expected: both zips written, tests PASS, lint 0 errors.
- [ ] **Step 4: Commit**
  ```bash
  git add README.md CHANGELOG.md manifest.json package.json
  git commit -m "Docs and 1.3.0 packaging"
  ```
