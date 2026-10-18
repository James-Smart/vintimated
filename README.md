# Vintimated

Relist one or many Vinted listings safely, with refreshed photos.

## What Vintimated does

Vintimated is a browser extension for Vinted sellers:

- **Single relist**: one click on a listing copies its photos and details,
  waits until the copy is ready, and only then removes the old listing and
  publishes the copy — so nothing is deleted until its replacement exists, and
  your item goes back on top of the search results.
- **Bulk relist**: on your own wardrobe page, tick the items you want (or take
  them all) and let Vintimated walk through them one at a time as a paced,
  stoppable queue.
- **Photo refresh**: the photos a relist uploads are not the bytes that came
  down — each one is invisibly transformed on the way up, so a relisted item
  does not read to Vinted as the same listing twice.

## Bulk relist

Open **your own wardrobe page** (your profile's items). Every relistable item
gets a checkbox, and a bar at the bottom of the page offers:

- **Select loaded** — tick every item currently on the page.
- **Clear** — empty the selection.
- **Relist selected (N)** — run the ticked items through the same safe relist
  sequence the single Relist button uses, one at a time, 10–30 seconds apart
  on top of the normal cooldowns.
- **Relist all** — fetch every active listing of yours through Vinted's API
  (a page at a time) and run those. Sold and reserved items are never queued.
  If Vinted's API has changed shape and cannot be read, Vintimated falls back
  to the items on screen and tells you it did.
- **Stop** — finish the item currently in progress, then halt. Nothing new
  starts.

Before anything runs, one confirmation shows the item count. If the run would
push your tally to the volume limits (see Pacing below), a second warning
dialog appears; that is the only other question asked for the whole walk.

A Vinted refusal mid-run — a 429 or a bot challenge — halts the queue
immediately, with the items not yet relisted left untouched. When the run
ends, the page reloads once if the "Reload the page" setting is on.

## Photo refresh

A relist whose photos arrive unchanged reads to Vinted as the same listing
twice. With photo refresh on (the default), every photo is changed on the way
up in ways no buyer will notice:

- a small random rotation (up to about 1.2°) with a re-crop that covers the
  frame, so no tilted edge shows;
- a per-channel colour nudge and a light dusting of pixel noise;
- a clean JPEG re-encode (metadata stripped, longest edge capped at 2048 px).

In `bordered` mode a thin white border (about 1–2% of the photo's short edge)
is added as well — visible proof the photo was refreshed.

Two things stay true whatever the mode: the bytes Vinted receives are the
refreshed ones, while the recovery copy kept in your browser holds the
original bytes; and a photo that fails to transform is uploaded exactly as it
came down — a relist never fails, or pauses to worry, over a photo.

## Settings

All settings live in the extension popup.

| Setting | Storage key | What it does | Default |
| --- | --- | --- | --- |
| Vintimated on/off | `vintimated:enabled` | Master switch. Off removes Vintimated's buttons and bulk bar and it acts on nothing. | On |
| Wait 10 seconds between relists | `vintimated:hardCooldown` | A hard 10 s cooldown measured from the moment the old listing is removed to the start of the next relist. Off sends them back to back — the pattern Vinted blocks accounts for. | On |
| Pause 0.9 to 2.4 s between requests | `vintimated:pace` | Random breathing room between the individual requests of a relist (`safe`). Off switches to `fast`: 0.25–0.7 s, fast enough to read as an automated script. | On (`safe`) |
| Refresh the photos on upload | `vintimated:photoRefresh` | What a relist hands Vinted for photos: `off` — bytes unchanged, the same photo twice, which is what a duplicate listing looks like; `stealth` — the invisible transforms described above; `bordered` — the same invisible changes plus the thin white frame. | `bordered` |
| Reload the page | `vintimated:reloadAfterRelist` | Reload after a relist so the copy shows up immediately (and once at the end of a bulk run). Off keeps your place on the page. | On |
| Language | `vintimated:lang` | Override the interface language (English, Italiano, Français) or follow the browser. | Automatic |

A hidden setting, `vintimated:localDrafts`, controls where a relist's copy is
held while it is published (on this device by default; off saves a draft to
your Vinted account first, as in versions before 1.0.1). It is described with
the recovery box below.

## Staying out of trouble

The safety rules of Bumpline are preserved and extended to bulk runs:

- **Nothing is deleted until a copy is held.** Before an original is removed,
  the full item — fields and the original photo bytes — is written to your
  browser. Only then is the original deleted and the copy published.
- **The recovery box.** If Vinted refuses to publish after the original is
  gone, the copy is not lost: a card appears on Vinted pages naming the item
  and Vinted's reason, with **Retry now**, **Download data** and **Discard**.
  Publishing is retried on every Vinted page you open until it works.
- **Stop on refusal.** When Vinted answers 429 or challenges the browser, the
  extension stands down: 15 minutes for a 429, 30 for a 403, doubling with
  each further refusal inside a day, capped at 6 hours (Vinted's own
  Retry-After wins when it asks for longer). A bulk queue halts the same way,
  leaving the remaining items untouched.

### Pacing defaults — and why they stay on

Defaults are the cautious ones and stay on: random 0.9–2.4 s pauses between
requests, a hard 10 s cooldown between relists, and volume alarms at **4
relists per hour / 15 per day** (shown in the popup). A bulk run asks before
it starts and warns a second time when it would cross those lines.

Neither number is Vinted's — Vinted publishes none. They are deliberately
cautious guesses at where tidying a wardrobe stops looking like tidying a
wardrobe. The faster settings exist, but back-to-back relists and bursts are
exactly what the blocking heuristics look for, so the defaults are yours to
keep rather than to fix.

## Installation from source

There is no npm install step; the build script uses only Node (18+) built-ins.

1. Build the packages:

   ```bash
   node build.mjs
   ```

   This writes `build/vintimated-<version>-chrome/` and
   `build/vintimated-<version>-firefox/` (plus a store-ready zip for each).

2. Load it unpacked:

   - **Chrome / Edge**: open `chrome://extensions`, enable Developer mode,
     click **Load unpacked**, and choose `build/vintimated-<version>-chrome/`.
   - **Firefox**: open `about:debugging#/runtime/this-firefox`, click
     **Load Temporary Add-on…**, and choose the `manifest.json` inside
     `build/vintimated-<version>-firefox/`.

## Based on Bumpline by g1ampy — GPL-3.0

Vintimated is a fork of [Bumpline by g1ampy](https://github.com/g1ampy/Bumpline),
a one-click Vinted relister. Bumpline is Copyright (C) 2026 g1ampy and is
licensed under the [GNU General Public License v3.0](LICENSE); Vintimated is
distributed under the same license. Upstream's copyright headers are preserved
in every source file, and changes are marked
`Modifications Copyright (C) 2026 Vintimated contributors.`

## Risk and terms of service

Automating Vinted is very likely against Vinted's terms of service. Using this
extension can get your listings removed, your account limited, or your account
banned. Vintimated paces its actions and stops when Vinted refuses a request,
but none of that is permission or protection. **You are responsible for how you
use this.**

## Not affiliated with, endorsed by, or connected to Vinted

Vintimated is an independent, unofficial project. Not affiliated with, endorsed
by, or connected to Vinted.
