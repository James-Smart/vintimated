# Vintimated — design

**Date:** 2026-10-18
**Status:** Approved direction — fork g1ampy/Bumpline (GPL-3.0), add bulk relist and photo refresh.

## Intent

A personal-use browser extension for Vinted sellers that relists your own
listings — one, many, or all of them — back to the top of search, and rewrites
the photos on the way up so Vinted does not see the relist as a duplicate
listing. Built as a fork of [g1ampy/Bumpline](https://github.com/g1ampy/Bumpline),
which already solves single-item relisting safely, and made better in exactly
the two places it falls short.

**Why now:** relisting is the only way an old item regains visibility (Vinted
has no relist button), it takes 3–5 minutes per item by hand, and byte-identical
photo re-uploads are what get relisted items flagged, suppressed, and — per
seller reports — accounts warned.

## Goals

1. **Bulk relist:** select 1, many, or all active listings and relist them as a
   paced queue, with stop/pause control and a clear result summary.
2. **Photo refresh:** every photo leaving the extension is rewritten at upload
   time — geometry, pixel statistics, colour signature and file fingerprint all
   changed — either invisibly or behind a visible border, per a setting.
3. **Keep Bumpline's safety guarantees:** nothing is deleted until a full copy
   of the item and its photo bytes is held locally; publishing is retried until
   it works; the extension stands down when Vinted refuses (429 / bot
   challenge) or the account is restricted.
4. **Chrome and Edge (MV3) and Firefox**, built from one vanilla-JS codebase
   with zero runtime dependencies; all processing local to the browser.

## Non-goals

- Scheduling or background relisting (no alarm-driven automation).
- Mobile apps, multi-account management, cross-posting to other marketplaces.
- Rewriting titles, descriptions, or prices (photo/text freshness beyond the
  photos is out of scope for this version).
- Relisting sold or reserved items (Vinted refuses the copy; Bumpline hides the
  buttons and so do we).
- Publishing to the Chrome Web Store or Firefox Add-ons (we build packages;
  store submission is a separate decision).
- A new logo or icon set (Bumpline's icons ship as-is until someone draws one).

## Anti-goals

- **An account warning or ban caused by our traffic shape.** Pacing defaults
  stay on (random inter-request pause, inter-relist cooldown, hourly/daily
  volume alarms, stop-on-refusal with backoff). Bulk mode must be *quieter*
  than hammering the button, not louder.
- **A listing lost between delete and publish.** The copy-before-delete
  sequence is sacred; no feature may reorder or skip it.
- **Photos that look processed to buyers.** Changes are subtle by default;
  the visible border mode is opt-out-able and thin.

## Constraints

- **License:** GPL-3.0. Bumpline is GPL-3.0; a fork is a derivative work and
  stays GPL-3.0. Keep g1ampy's copyright headers, add our own for
  modifications, keep LICENSE, credit the upstream in README.
- **Zero runtime dependencies.** No npm packages shipped; `node --test`
  (Node built-in) for development tests. `build.mjs` stays dependency-free.
- **Vanilla JS classic scripts.** No bundler, no ES modules in content scripts;
  new modules are classic scripts exposing one global, with a CommonJS export
  guard so Node tests can require them.
- **All processing local.** The only network traffic is to Vinted itself.
  Photos never leave the device except to Vinted.
- **ToS reality:** automating Vinted is very likely against their terms. This
  is the user's own account and their own listings; the README says the risk
  plainly. Nothing here is marketed or built to evade enforcement beyond the
  photo-refresh that the feature itself requires.

## Decisions

- **Base:** verbatim import of Bumpline's runtime sources first (one commit),
  then our changes on top, so every diff against upstream stays readable.
- **Rebrand:** product name *Vintimated*; identifiers, CSS classes, storage
  key prefix (`vintimated:`), IndexedDB name and console tag renamed in the
  import commit; GPL headers preserved. Internal storage values (pending
  relist records) need no migration — nobody has run this fork yet.
- **Photo refresh modes:** `off` | `stealth` (invisible transforms) |
  `bordered` (invisible transforms + thin visible border). Default:
  `bordered` — it is what the feature was asked for, and it doubles as visible
  proof the refresh happened. Setting key `vintimated:photoRefresh`.
- **Transform at upload, originals in the backup:** the bytes sent to Vinted
  are refreshed; the local recovery copy (IndexedDB) keeps the *original*
  bytes so the emergency download stays pristine. The recovery re-upload path
  refreshes again at send time.
- **Transform set:** small random rotation (~±0.4–1.2°) with cover-fill
  re-crop (~2–5% overshoot), per-channel colour nudge, low-amplitude pixel
  noise, clean JPEG re-encode (metadata stripped by canvas), optional thin
  border (~1.5% of the short edge) in `bordered` mode. Mirroring is not
  included (breaks text in photos).
- **"All" means all active listings**, enumerated through Vinted's user-items
  API with paging (falling back to the cards currently in the DOM if the API
  shape has changed), filtered to items Vinted would let us copy. Sold and
  reserved items are never queued.
- **Bulk queue semantics:** one item at a time, in selection order; the queue
  finishes the current item before honouring Stop; a refusal (429 / challenge)
  halts the queue with the remaining items untouched and un-deleted; a
  per-item failure is recorded and the queue moves on; the volume-alarm
  confirmation is asked **once** at queue start with the planned count, not
  per item. Inter-item gap: Bumpline's hard cooldown plus a random extra
  (10–30s), so a bulk run reads slower than hand-clicking.
- **Page reload:** suppressed between bulk items (cards update in place); one
  reload at the end when the existing *Reload the page* setting is on.
- **Rename of upstream internals** stays mechanical (find-and-replace class of
  change) so merges from upstream remain feasible.

## Left to the builder

- Exact shape of the user-items enumeration endpoint on the live site (verify
  in the network tab; the fallback path must work regardless).
- JPEG encode quality constant and max-edge downscale value tuning (start at
  0.92 quality, 2048px max edge).
- Popup layout details for the photo-refresh setting row (follow the existing
  settings-row pattern in popup.html/popup.js).
